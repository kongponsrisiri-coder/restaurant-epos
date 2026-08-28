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
const printAlerts = require('./services/printAlertService'); // SEPOS-PRINT-ALERT-001
const stuartService = require('./services/stuartService');
const uberDirectService = require('./services/uberDirectService');
const deliverooService = require('./services/deliverooService');

const app = express();
// SEPOS-AUDIT-002 F16 — behind Railway/Cloudflare every request arrives from the
// edge proxy, so an untrusted req.ip is the SAME string for the whole planet:
// 8 wrong PINs locked out every staff member at every restaurant.
app.set('trust proxy', 1);
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// SEPOS-PRINT-ALERT-001 — held-ticket queue + printer health pinger
// (no-ops entirely unless DB_MODE=local, i.e. a desktop till).
printAlerts.init({ pool, io, printService });

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
// SEPOS-SALESCHAT-002 — Messenger webhook needs the raw body for Meta's
// X-Hub-Signature-256 HMAC, same pattern as stripe/line above.
app.use('/api/messenger/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// SEPOS-047c — single source of truth for an order's live total: the sum
// of non-voided item line totals WITH per-item discounts applied. Every
// path that recomputes orders.total (add items, void, merge, item
// discount) MUST use this — otherwise add/void/merge silently revert a
// discounted total to the raw undiscounted sum, corrupting the bill and
// the Z-report subtotal/discount figures. GREATEST → max() and the
// arithmetic both translate cleanly to SQLite (verified in translateSql).
// SEPOS-QR-PAY-REDO (verify pass, round 5) — a table can now hold more than one
// open order (a waiter bill + a customer's prepaid QR bill). Freeing it must
// therefore be conditional EVERYWHERE, not just on the /pay success path. This
// is the single implementation every close/cancel/void/merge/delete path calls,
// so the guard can never again be added to some sites and forgotten on others.
// SEPOS-QR-PAY-REDO (verify pass, round 6) — a QR order is the customer's
// prepaid, staff-READ-ONLY bill. Staff mutating it (void, discount, service
// charge…) strands the customer's money or fabricates uncollected revenue,
// because the tender was fixed at order time. One guard for every such
// endpoint, so the rule can't be enforced on some and forgotten on others
// (it already was: /items and /merge had it, void/discount/service-charge
// didn't). Refunds/changes to a prepaid order go through the payment provider,
// not the till. Returns true (and answers 409) when the order is a QR order.
async function refuseQrMutation(orderId, res) {
  // SEPOS-QR-PAYLATER-001 — the rule protects PREPAID money. A pay-later QR
  // order carries no customer payment, so staff mutate/tender it like any
  // bill; only paid/mock QR orders stay read-only.
  const r = await pool.query('SELECT source, payment_status FROM orders WHERE id = $1', [orderId]);
  if (r.rows[0] && r.rows[0].source === 'qr' && ['paid', 'mock'].includes(String(r.rows[0].payment_status || ''))) {
    res.status(409).json({ error: 'This is a customer prepaid QR order — it can\'t be changed on the till. Refund or adjust it through the payment provider.', qrReadOnly: true });
    return true;
  }
  return false;
}

async function freeTableIfEmpty(tableId) {
  if (tableId == null) return;
  const r = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE table_id=$1 AND status='open'", [tableId]);
  if (Number(r.rows[0]?.n || 0) === 0) {
    await pool.query("UPDATE tables SET status='available' WHERE id=$1", [tableId]);
  }
}

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
// SEPOS-DISCOUNT-SCOPE-001 — a bill discount may be limited to 'food' or
// 'drink' (orders.discount_scope; NULL/'all' = whole bill). Drinks = items in
// categories with is_bar=1, mirroring the kitchen/bar routing split.
function rowInScope(scope, isBar) {
  if (scope === 'drink') return Number(isBar) === 1;
  if (scope === 'food')  return Number(isBar) !== 1;
  return true;
}

// Scope-aware bill-discount £ for one order. `items` rows need quantity,
// unit_price, discount_type/discount_value (item-level), voided, is_bar.
function billDiscountAmountFor(order, items) {
  const bdv = Number(order.discount_value || 0);
  if (!(bdv > 0)) return 0;
  const scope = order.discount_scope || 'all';
  let base = 0;
  for (const it of items) {
    if (it.voided) continue;
    if (!rowInScope(scope, it.is_bar)) continue;
    let p = Number(it.unit_price || 0) * Number(it.quantity || 0);
    if (it.discount_value > 0) {
      if (it.discount_type === 'percent') p *= 1 - Number(it.discount_value) / 100;
      else p = Math.max(0, p - Number(it.discount_value));
    }
    base += p;
  }
  return order.discount_type === 'percent' ? base * (bdv / 100) : Math.min(bdv, base);
}

function billDiscountFactors(rows) {
  // Per order: full gross + in-scope gross (both after per-ITEM discounts).
  const grossByOrder = new Map();
  for (const row of rows) {
    let g = Number(row.quantity || 0) * Number(row.unit_price || 0);
    if (row.discount_type === 'percent') g *= 1 - (Number(row.discount_value || 0) / 100);
    else if (row.discount_type === 'fixed') g = Math.max(0, g - Number(row.discount_value || 0));
    let e = grossByOrder.get(row.order_id);
    if (!e) {
      e = { full: 0, scoped: 0,
            scope: row.bill_discount_scope || 'all',
            type: row.bill_discount_type, value: Number(row.bill_discount_value || 0) };
      grossByOrder.set(row.order_id, e);
    }
    e.full += g;
    if (rowInScope(e.scope, row.is_bar)) e.scoped += g;
  }
  // order_id -> { f: factor for IN-SCOPE rows, scope, amount: discount £ }.
  // Out-of-scope rows always keep factor 1 — use rowBillFactor(), not .f.
  const factor = new Map();
  for (const [oid, e] of grossByOrder) {
    const base = e.scope === 'all' ? e.full : e.scoped;
    let f = 1, amount = 0;
    if (e.value > 0 && base > 0) {
      if (e.type === 'percent')    { amount = base * (e.value / 100); f = Math.max(0, 1 - e.value / 100); }
      else if (e.type === 'fixed') { amount = Math.min(e.value, base); f = Math.max(0, (base - amount) / base); }
    }
    factor.set(oid, { f, scope: e.scope, amount });
  }
  return factor;
}

// The multiplicative bill-discount factor for ONE item row: the order's
// factor when the row is in the discount's scope, 1 otherwise.
function rowBillFactor(factors, row) {
  const e = factors.get(row.order_id);
  if (!e) return 1;
  return rowInScope(e.scope, row.is_bar) ? e.f : 1;
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
function serviceChargeForOrder(o, scEnabled, scRatePct, billDiscountOverride = null) {
  // SEPOS-AUDIT-001 — prefer the close-time SNAPSHOT (orders.service_charge,
  // stamped by /pay since this fix). Deriving from today's settings rewrote
  // history whenever the rate changed. NULL = legacy row → derive as before.
  if (o.service_charge !== null && o.service_charge !== undefined) return Number(o.service_charge) || 0;
  if (!scEnabled) return 0;
  if (o.no_service_charge) return 0;
  if (!orderIsDineIn(o)) return 0;
  // SEPOS-SVCFIX-001 fix — charge on the base AFTER any bill-level discount,
  // matching what the till actually took (BillScreen applies service to
  // subtotal − bill discount). Using o.total (pre-bill-discount) overstated
  // service on discounted bills. Per-item discounts are already baked into total.
  // SEPOS-DISCOUNT-SCOPE-001 — a food/drink-scoped discount needs the order's
  // ITEMS to compute its £, so /pay passes it in (billDiscountOverride). This
  // derive branch only otherwise runs for legacy rows (service_charge NULL),
  // which predate scoped discounts — every scoped order carries a snapshot.
  let base = Number(o.total ?? 0);
  if (billDiscountOverride != null) {
    base = Math.max(0, base - Number(billDiscountOverride));
  } else if (o.discount_value > 0) {
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

// SEPOS-AUTO-SESSION-001 — open a till session automatically at the day's
// first sale if none is open. A shift the staff open late (or not at all)
// leaves paid bills outside every Z's session window — the money is in the
// reports but the printed Z under-counts, which reads as missing takings.
// Called from every order-create path and from bill close; mirrors the
// offline branch of POST /api/till-sessions/open (queued cloud replay, and
// the unique open-session index turns a two-terminal race into a no-op).
async function ensureOpenSession(rid) {
  const restaurantId = rid || process.env.RESTAURANT_ID || 'siamepos';
  try {
    const existing = await pool.query(
      "SELECT id FROM till_sessions WHERE status='open' AND restaurant_id=$1 LIMIT 1", [restaurantId]);
    if (existing.rows[0]) return existing.rows[0].id;
    const r = await pool.query(
      `INSERT INTO till_sessions (status, opened_at, opened_by, float_amount, restaurant_id)
       VALUES ('open', NOW(), NULL, 0, $1) RETURNING id`, [restaurantId]);
    try { await offlineQueue.enqueue('session_open', { staff_id: null, float_amount: 0 }); } catch {}
    console.log(`[auto-session] no shift was open — opened one for ${restaurantId}`);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (err) {
    if (!(String(err.code) === '23505' || /idx_till_sessions_open|UNIQUE/i.test(err.message))) {
      console.error('[auto-session] open failed:', err.message);
    }
    return null;
  }
}

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
  // SEPOS-027 — the SMS sender was never assigned here, so the dormant
  // stub swallowed every booking SMS even once TWILIO_* env landed.
  sendBookingSms = emailSvc.sendBookingSms;
  console.log('✅ Email service loaded');
} catch (e) {
  console.log('ℹ️  Email service not configured yet — skipping');
}

app.get('/api/tables', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tables ORDER BY table_number, id'); // SEPOS-TABLE-IDENT-001 — stable order when numbers ever tie
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
    // SEPOS-TABLE-NAME hardening — pos/size/capacity are INTEGER columns but
    // browsers report sub-pixel drag coords (42.121…), which used to 500 the
    // whole row (and with it any name/capacity change riding along). Round
    // every numeric here so no client version can poison a table again.
    const int = (v, fallback = null) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    // COALESCE keeps the existing is_takeaway flag when a partial plan update
    // (e.g. drag/resize) doesn't include it — only an explicit toggle changes it.
    // SEPOS-TABLE-IDENT-001 REVERTED (Korakot, 24 Aug): table setup is
    // FREEFORM by his decision — clients may reuse numbers/names on purpose.
    // The editor no longer needs the guard: rows bind by id, the list orders
    // by (table_number, id) so twins are stable, and the rename box commits
    // once on settle. Do not re-add a duplicate restriction.
    await pool.query(
      'UPDATE tables SET pos_x=$1, pos_y=$2, shape=$3, width=$4, height=$5, name=$6, capacity=$7, table_number=$8, is_takeaway=COALESCE($9, is_takeaway) WHERE id=$10',
      [int(pos_x, 0), int(pos_y, 0), shape, int(width, 80), int(height, 80), name, int(capacity, 4), int(table_number), (is_takeaway == null ? null : (is_takeaway ? 1 : 0)), req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables', async (req, res) => {
  if (await maybeForwardTableWriteToCloud(req, res)) return;
  try {
    const { table_number, capacity, pos_x, pos_y, shape, is_takeaway } = req.body;
    const int = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : fb; };
    const result = await pool.query(
      'INSERT INTO tables (table_number, capacity, pos_x, pos_y, shape, is_takeaway) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [int(table_number, null), int(capacity, 4), int(pos_x, 0), int(pos_y, 0), shape || 'square', is_takeaway ? 1 : 0]
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
  // SEPOS-TABLEPLAN-POPBACK — walls are cloud-wins pulled every tick but their
  // writes never forwarded, so on a desktop till EVERY wall edit reverted
  // within seconds. Forward like tables.
  if (await maybeForwardTableWriteToCloud(req, res)) return;
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
  if (await maybeForwardTableWriteToCloud(req, res)) return;
  try {
    const { pos_x, pos_y, width, height } = req.body;
    const int = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : fb; };
    await pool.query(
      'UPDATE table_walls SET pos_x=$1, pos_y=$2, width=$3, height=$4 WHERE id=$5',
      [int(pos_x, 0), int(pos_y, 0), int(width, 12), int(height, 100), req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/table-walls/:id', async (req, res) => {
  if (await maybeForwardTableWriteToCloud(req, res)) return;
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
async function forwardWriteToCloud(req, res, label, afterPull, opts = {}) {
  try {
    const archiveService = require('./services/archiveService');
    if (!archiveService.isLocalInstall() || !process.env.CLOUD_API_URL) return false;
  } catch { return false; }
  try {
    const url = `${process.env.CLOUD_API_URL}${req.originalUrl}`;
    // Verify pass — bounded: a wedged cloud (accepts TCP, never answers) used
    // to hang the till's request forever. 8s then fall back to local.
    // REG-1b (Fern/demo, 17 Aug) — carry the install's SYNC_SECRET, exactly as
    // forwardToCloudWith already does (REG-1). Without it, every forwarded
    // staff/table write hit the cloud's requireStaffAuth gate with NO auth at
    // all → 401 "sign out and sign in again" relayed onto the operator's
    // screen and the change never saved ANYWHERE, however freshly they were
    // signed in (the local Bearer token can't verify on the cloud — different
    // signing secret — so the shared secret is the only valid relay identity).
    const init = { method: req.method, headers: { 'Content-Type': 'application/json', ...(process.env.SYNC_SECRET ? { 'x-sync-secret': process.env.SYNC_SECRET } : {}) }, signal: AbortSignal.timeout(8000) };
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
    // strict: an UNQUEUED local fallback would be a DOOMED write — the table
    // is cloud-wins on every pull, so a local-only change survives seconds and
    // then "pops back" (Korakot, Baan Siam floor plan, 2026-08-03→05: edits
    // made while the cloud was mid-redeploy silently reverted).
    //
    // SEPOS-CONFIG-QUEUE ("the till is the boss", Korakot 2026-08-05): for
    // UPDATE/DELETE we now queue a config_write replay and fall through to the
    // local handler — the operator's edit applies instantly, survives offline,
    // and pushes to the cloud when it returns; pullFromCloud skips rows with a
    // pending config_write so the edit can't be reverted meanwhile. CREATEs
    // still require the cloud (a new row needs its cloud id) and fail loud.
    if (opts.strict) {
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const qid = await offlineQueue.enqueue('config_write', {
          method: req.method, path: req.originalUrl, body: req.body || {},
        });
        if (qid) {
          console.warn(`[${label}] cloud unreachable for ${req.method} ${req.originalUrl}: ${err.message} — queued config_write #${qid}, applying locally (till is the boss)`);
          return false;   // local handler applies the edit; queue replays it later
        }
      }
      console.warn(`[${label}] cloud unreachable for ${req.method} ${req.originalUrl}: ${err.message} — rejecting (strict write-through)`);
      res.status(503).json({ error: 'Cloud unreachable — change not saved. Check the internet connection and try again in a minute.' });
      return true;
    }
    console.warn(`[${label}] cloud unreachable for ${req.method} ${req.originalUrl}: ${err.message} — falling back to local (change will be lost on next pull)`);
    return false;
  }
}

// SEPOS-AUDIT-001 — like forwardWriteToCloud but with URL/body overrides, for
// endpoints whose path or payload carries a LOCAL order id that must be
// translated to the cloud id before forwarding (vouchers, deposits). Returns
// false (→ caller falls back to the local handler) when this isn't a local
// install, the cloud is unreachable, or the caller couldn't build overrides.
async function forwardToCloudWith(req, res, label, { path, body, afterOk } = {}) {
  try {
    const archiveService = require('./services/archiveService');
    if (!archiveService.isLocalInstall() || !process.env.CLOUD_API_URL) return false;
  } catch { return false; }
  try {
    const url = `${process.env.CLOUD_API_URL}${path || req.originalUrl}`;
    // Verify pass — bounded (see forwardWriteToCloud): 8s then local fallback.
    // REG-1 (Nook) — carry the install's SYNC_SECRET so forwards to now-gated
    // cloud endpoints (voucher list etc.) authenticate server-to-server.
    const fwdHeaders = { 'Content-Type': 'application/json' };
    if (process.env.SYNC_SECRET) fwdHeaders['x-sync-secret'] = process.env.SYNC_SECRET;
    const init = { method: req.method, headers: fwdHeaders, signal: AbortSignal.timeout(8000) };
    const payload = body !== undefined ? body : req.body;
    if (req.method !== 'GET' && req.method !== 'HEAD' && payload && Object.keys(payload).length) {
      init.body = JSON.stringify(payload);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    console.log(`[${label}] forwarded ${req.method} ${path || req.originalUrl} → cloud ${r.status}`);
    if (r.ok && afterOk) {
      try { await afterOk(JSON.parse(text || '{}')); }
      catch (afterErr) { console.warn(`[${label}] after-forward step failed: ${afterErr.message}`); }
    }
    res.status(r.status).type('application/json').send(text);
    return true;
  } catch (err) {
    console.warn(`[${label}] cloud unreachable for ${req.method} ${req.originalUrl}: ${err.message} — falling back to local`);
    return false;
  }
}

// SEPOS-AUDIT-001 — local order id → cloud id (local installs only; the
// orders.cloud_id column exists in the local SQLite schema). Null when unbound.
async function localOrderCloudId(orderId) {
  try {
    const r = await pool.query('SELECT cloud_id FROM orders WHERE id = $1', [orderId]);
    return r.rows[0]?.cloud_id ?? null;
  } catch { return null; }
}

// SEPOS-046q — desktop installs forward menu admin writes to cloud so the
// operator's edits become the new cloud truth (instead of being silently
// erased by the next pull tick). On success, an instant menu pull brings
// the cloud-acknowledged shape into local SQLite. On failure, the request
// falls back to the local handler so the operator's UI still updates.
function maybeForwardMenuWriteToCloud(req, res) {
  // SEPOS-CONFIG-QUEUE phase 2 — strict: offline UPDATE/DELETE queue + apply
  // locally (till is the boss); CREATE needs the cloud (new row = cloud id).
  return forwardWriteToCloud(req, res, 'menu-write', () => syncService.pullMenuSnapshot(), { strict: true });
}

// SEPOS-059 — modifier-library writes pull the flat modifier tables back (not the
// menu tree), so the till admin's refetch shows the new/removed option instantly
// instead of only after the next 5s tick (the "had to close & reopen" bug).
function maybeForwardModifierWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'modifier-write', () => syncService.pullModifiersSnapshot(), { strict: true });
}

// SEPOS-027 — floor-plan writes (tables + linked groups) forward to cloud so the
// cloud (which online booking uses for table-aware availability) stays in sync
// with the till, which is the only place the floor plan is edited.
function maybeForwardTableWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'table-write', () => syncService.pullTablesSnapshot(), { strict: true });
}

// SEPOS-047g — same write-through for staff/PIN edits. Before this, staff
// endpoints wrote ONLY to local SQLite on desktop — no cloud forward, no
// push queue — so a PIN added/changed/deleted on the till never reached
// the cloud, the website, or any other device (and could later be clobbered
// when the 5s pull's upsert-by-id collided with a different cloud staff id).
// Now a desktop staff write becomes the cloud truth and the instant staff
// pull (with orphan-delete) reflects it locally + everywhere on next tick.
function maybeForwardStaffWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'staff-write', () => syncService.pullStaffSnapshot(), { strict: true });
}

// SEPOS-MENU-COLOR-001 — owner-editable button colour for category /
// subcategory / menu item. One endpoint, whitelisted tables; color is a
// '#rrggbb' hex or null (back to the default look).
app.put('/api/menu-color', async (req, res) => {
  // Review M1 + canary fix — cloud-first when the cloud SUPPORTS the endpoint,
  // skew-tolerant when it doesn't: an older cloud answers 404 (endpoint not
  // deployed yet) and a strict forward turned that into a failed save on the
  // till (found live on the v1.26 host canary). Now: try the cloud; swallow
  // ONLY 404 (old cloud) and offline; surface real cloud errors; and always
  // write locally on success so the UI is instant — the menu pull reconciles
  // (old clouds send no color key and the upsert drops null/undefined, so the
  // local value survives until the cloud catches up).
  try {
    const { type, id, color } = req.body || {};
    const table = { category: 'categories', subcategory: 'subcategories', item: 'menu_items' }[type];
    if (!table || !id) return res.status(400).json({ error: 'type (category|subcategory|item) and id required' });
    const c = (color == null || color === '') ? null : String(color);
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return res.status(400).json({ error: 'color must be #rrggbb or null' });
    const cloudUrl = process.env.CLOUD_API_URL;
    if (cloudUrl) {
      try {
        const r = await fetch(cloudUrl.replace(/\/+$/, '') + '/api/menu-color', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, id, color: c }),
          signal: AbortSignal.timeout(8000), // F4: a wedged cloud must not hang the save
        });
        if (!r.ok && r.status !== 404) {
          const t = await r.text().catch(() => '');
          return res.status(r.status).json({ error: 'cloud rejected the colour: ' + t.slice(0, 120) });
        }
      } catch { /* offline — colour still applies locally below */ }
    }
    await pool.query(`UPDATE ${table} SET color = $1 WHERE id = $2`, [c, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    // SEPOS-COURSE-CASCADE-001 (Korakot, 25 Aug — "i change the category
    // course but inside didnt change along it"): changing a category's course
    // must carry its dishes with it. Menu imports stamped an explicit course
    // on every dish, so nothing ever inherited and this chip looked dead.
    // Any dish whose per-item course EQUALS the category's OLD course was a
    // de-facto follower — reset it to NULL (inherit) so it moves with the
    // category now and forever. A dish with a DIFFERENT override is a
    // deliberate exception (mixed Lunch menu) and keeps it.
    const prev = await pool.query('SELECT default_course FROM categories WHERE id = $1', [req.params.id]);
    const oldCourse = Number(prev.rows[0]?.default_course || 1);
    await pool.query('UPDATE categories SET default_course = $1 WHERE id = $2', [default_course, req.params.id]);
    await pool.query(
      'UPDATE menu_items SET default_course = NULL WHERE category_id = $1 AND default_course = $2',
      [req.params.id, oldCourse]
    );
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
    // SEPOS-PRINT-STAR-001 — a starred default only counts while that printer
    // still CARRIES the role. Before this, unticking (say) Bar on the starred
    // printer and ticking it on another changed nothing: the stale star kept
    // winning and tickets went to the old printer with no visible reason.
    // Stale/roleless star → fall through to the first printer flagged with
    // the role, i.e. what the operator's ticks say.
    const starred = defId ? byId.get(String(defId)) : null;
    const p = (starred && Number(starred[`role_${role}`]) === 1 ? starred : null)
      || printers.find(x => Number(x[`role_${role}`]) === 1);
    if (!p || !(p.ip || p.name)) continue;
    settings[`printer_${role}_ip`]        = p.ip || '';
    settings[`printer_${role}_port`]      = p.port || 9100;
    settings[`printer_${role}_name`]      = p.name || '';
    settings[`printer_${role}_lpr_queue`] = p.lpr_queue || settings[`printer_${role}_lpr_queue`] || 'lp';
    if (role === 'kitchen' && p.copies) settings.printer_kitchen_copies = String(p.copies);
  }
  // SEPOS-PRINT-ORPHAN-001 (Yum Yum, 24 Aug) — self-clean orphaned role IPs.
  // A role whose KV ip matches NO active printer row, with no row carrying the
  // role, is a ghost of a deleted printer (the bench-printer banner that
  // survived every clear). Tombstone it so pings and prints stop chasing it.
  for (const role of ['receipt', 'kitchen', 'bar']) {
    const hasRoleRow = printers.some(x => Number(x['role_' + role]) === 1 && (x.ip || x.name));
    if (hasRoleRow) continue;
    const kvIp = settings['printer_' + role + '_ip'];
    if (kvIp && !printers.some(x => x.ip === kvIp)) {
      settings['printer_' + role + '_ip'] = '';
      settings['printer_' + role + '_name'] = '';
    }
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
  // Local install = the server is ON the restaurant LAN (desktop/Sunmi). Inline
  // the DB_MODE check — archiveService is require()'d locally per-function, not
  // module-scoped, so referencing it here would throw.
  const isLocal = String(process.env.DB_MODE || '').toLowerCase() === 'local';
  if (!isLocal) {
    return res.json({ local: false, printers: [], message: 'Scanning finds printers on the same network — run it from the till / desktop app, or enter the IP manually.' });
  }
  try {
    const os = require('os'), net = require('net');
    // SEPOS-BILL-STATIONS-001 — sweep EVERY attached IPv4 /24, not just the
    // first: the travel printer kit lives on its own subnet (192.168.8.x via
    // a travel router or a temporary interface alias), which the old
    // first-interface-only scan never saw ("the till scanner can't find them",
    // Korakot 2026-08-06).
    const bases = new Set();
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const ni of ifaces || []) {
        if (ni.family === 'IPv4' && !ni.internal) bases.add(ni.address.split('.').slice(0, 3).join('.'));
      }
    }
    if (!bases.size) return res.json({ local: true, printers: [], message: 'No LAN connection found on this device.' });
    const port = 9100;
    const probe = (host) => new Promise((resolve) => {
      const s = new net.Socket();
      let done = false;
      const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok ? host : null); };
      // 900ms not 500 — cold ARP resolution on a fresh subnet eats most of a
      // 500ms budget and made first scans miss live printers.
      s.setTimeout(900);
      s.once('connect', () => finish(true));
      s.once('timeout', () => finish(false));
      s.once('error', () => finish(false));
      s.connect(port, host);
    });
    const hosts = [...bases].flatMap((b) => Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`));
    // Two passes, union — budget POS80 boards drop the probe if they're busy
    // with another connection, so any single sweep can miss a live printer
    // (seen live: 3 printers, each scan found a different 2 of them).
    const found = new Set();
    for (let pass = 0; pass < 3; pass++) {
      if (pass) await new Promise(r => setTimeout(r, 600));   // let busy boards recover
      const remaining = hosts.filter(h => !found.has(h));
      // Chunked, not all-at-once: 762 simultaneous SYNs storm the ARP table
      // and drown the printers' replies (first scan after boot found 1 of 3).
      for (let i = 0; i < remaining.length; i += 128) {
        (await Promise.all(remaining.slice(i, i + 128).map(probe))).filter(Boolean).forEach(ip => found.add(ip));
      }
    }
    res.json({ local: true, subnet: [...bases].map((b) => `${b}.0/24`).join(', '), printers: [...found].sort().map(ip => ({ ip, port })) });
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
    // Identity block on the slip (name/ip/roles) so the operator can tell
    // WHICH station printed — three identical printers, one shelf.
    const roles = [p.role_receipt ? 'Bills' : null, p.role_kitchen ? 'Kitchen' : null, p.role_bar ? 'Bar' : null].filter(Boolean).join(' + ') || undefined;
    await printService.testPrint(p.ip, p.port || 9100, '', { name: p.name, roles });
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
    const { name, name_alt, description, price, is_available, is_online, subcategory_id, category_id, vat_rate, default_course, printer_id, image_url, dietary } = req.body;
    // NULL / '' → inherit the category course; 1-4 → per-item override.
    const dc = (default_course == null || default_course === '') ? null : (Number(default_course) || null);
    // SEPOS-STATION-003 — per-dish station override. '' / null → inherit the
    // category's printer route; a printer id → this dish always prints there.
    const pid = (printer_id == null || printer_id === '') ? null : (Number(printer_id) || null);
    // SEPOS-QR-ORDER-001 — customer-menu card fields. Omitted → unchanged
    // (COALESCE); explicit '' clears. dietary accepts an array like allergens.
    const img = image_url === undefined ? null : (image_url || '');
    let diet = null;
    if (dietary !== undefined) {
      diet = Array.isArray(dietary) ? JSON.stringify(dietary) : (dietary ? JSON.stringify([dietary]) : '');
    }
    await pool.query(
      'UPDATE menu_items SET name=$1, name_alt=$2, description=$3, price=$4, is_available=$5, is_online=COALESCE($6, is_online), subcategory_id=$7, category_id=$8, vat_rate=COALESCE($9, vat_rate), default_course=$10, printer_id=$11, image_url=COALESCE($12, image_url), dietary=COALESCE($13, dietary) WHERE id=$14',
      [name, name_alt || null, description, price, is_available, is_online ?? null, subcategory_id || null, category_id, vat_rate ?? null, dc, pid, img, diet, req.params.id]
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
        ORDER BY COALESCE(is_global, 0), COALESCE(sort_order, 0), id`, [req.params.id]);
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
// SEPOS-060 — edit a library group's flags/order (sort_order drives the
// display order of option groups on the till + customer pages).
app.put('/api/modifier-library/:id', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    const { name, required, multi_select, sort_order } = req.body || {};
    await pool.query(
      `UPDATE modifier_groups SET
         name = COALESCE($1, name),
         required = COALESCE($2, required),
         multi_select = COALESCE($3, multi_select),
         sort_order = COALESCE($4, sort_order)
       WHERE id = $5`,
      [name ?? null, required ?? null, multi_select ?? null, sort_order ?? null, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const result = await pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = orders.id AND oi.voided = 0) AS item_count
      FROM orders LEFT JOIN tables ON orders.table_id = tables.id
      WHERE orders.status = 'open' ORDER BY orders.created_at DESC`);
    // SEPOS-GHOST-001 — hide phantom/ghost orders. An OPEN order with 0 items
    // that's older than a short grace window was abandoned (a double-tap on
    // "new order", or a backed-out create) and must NOT keep its table (esp. a
    // takeaway slot) occupied on the floor — that's the recurring "ghost table".
    // The grace window keeps a just-created order visible until its first item
    // is rung in, so live seating/creation still works.
    const GRACE_MS = 3 * 60 * 1000;
    const now = Date.now();
    const rows = result.rows.filter((o) => {
      if (Number(o.item_count) > 0) return true;               // real order — keep
      const t = o.created_at ? new Date(o.created_at).getTime() : now;
      return Number.isFinite(t) ? (now - t) < GRACE_MS : true; // empty: keep only if just created
    });
    res.json(rows);
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

// ─── SEPOS-CFD-001 — Customer-Facing Display ────────────────────────────────
// The cashier's till PUSHES what the customer should see (idle branding, or the
// live order + total) to this ephemeral in-memory relay; the second screen
// (a browser on <till-url>/#display, on this PC or a separate tablet) POLLS it.
// Server-brokered on purpose so it works cross-process/cross-device without
// Electron dual-window plumbing. State is per `station` (default 'main') so
// multiple tills never cross-show; it's display-only (item names + prices that
// are already on the customer's screen — no customer PII, no persistence).
const _cfdState = new Map();
const _CFD_IDLE = () => ({ mode: 'idle', updated_at: Date.now() });
// SEPOS-CFD-002 — every served state (including the 30s-stale idle fallback)
// carries the RESTAURANT's branding, read from settings with a 60s cache.
// Before this, 30 quiet seconds reverted the customer display to the bare
// SiamEPOS mark and colours (first noticed on the Yum Yum install, 23 Aug).
let _cfdBrandCache = { at: 0, val: {} };
async function _cfdBrand() {
  if (Date.now() - _cfdBrandCache.at < 60000) return _cfdBrandCache.val;
  try {
    const r = await pool.query(`SELECT key, value FROM settings WHERE key IN ('restaurant_name','company_name','brand_logo','company_logo','brand_primary','brand_accent')`);
    const cfg = {}; for (const row of r.rows) cfg[row.key] = row.value;
    _cfdBrandCache = { at: Date.now(), val: {
      restaurant_name: cfg.company_name || cfg.restaurant_name || undefined,
      logo: cfg.brand_logo || cfg.company_logo || undefined,
      brand_primary: cfg.brand_primary || undefined,
      brand_accent: cfg.brand_accent || undefined,
    } };
  } catch { /* keep the last good cache — worst case the display stays generic */ }
  return _cfdBrandCache.val;
}
app.post('/api/cfd/state', (req, res) => {
  const station = String((req.body && req.body.station) || 'main').slice(0, 40);
  const body = req.body || {};
  const state = {
    mode: body.mode === 'order' ? 'order' : 'idle',
    restaurant_name: typeof body.restaurant_name === 'string' ? body.restaurant_name.slice(0, 80) : undefined,
    logo: typeof body.logo === 'string' && body.logo.length < 300000 ? body.logo : undefined,
    order: body.mode === 'order' && body.order && typeof body.order === 'object' ? body.order : undefined,
    qr: body.qr && typeof body.qr === 'object' ? body.qr : undefined,
    updated_at: Date.now(),
  };
  _cfdState.set(station, state);
  if (_cfdState.size > 50) _cfdState.clear();   // never grows unbounded
  res.json({ ok: true });
});
app.get('/api/cfd/state', async (req, res) => {
  const station = String(req.query.station || 'main').slice(0, 40);
  const s = _cfdState.get(station);
  const brand = await _cfdBrand();  // SEPOS-CFD-002
  // Stale push (till closed/crashed) falls back to idle after 30s of silence.
  if (!s || Date.now() - s.updated_at > 30000) return res.json({ ..._CFD_IDLE(), ...brand });
  // Pushed state wins where it carries a value; settings fill the gaps, and
  // the brand colours always ride along (pushes never include them).
  res.json({ ...brand, ...s, logo: s.logo || brand.logo, restaurant_name: s.restaurant_name || brand.restaurant_name });
});

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
    const ordersRes = await pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status = 'open' ORDER BY orders.created_at DESC`);
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
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const itemsRes = await pool.query(
      `SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt, menu_items.category_id, categories.is_bar FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON categories.id = COALESCE(menu_items.category_id, order_items.dest_category_id) WHERE order_items.order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order, items: itemsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-GHOST-001 — per-key async mutex. Serialises async critical sections
// that share a key so a double-tapped "open table" can't race two INSERTs into
// two open orders on the same table (the "ghost table" phantom: one order gets
// the items, the empty twin lingers on the floor). Chains each call after the
// previous one for the key; swallows prior rejections so one failure doesn't
// poison the chain, and GCs the map entry once the tail settles.
const _orderCreateLocks = new Map();
function runExclusive(key, fn) {
  const prev = _orderCreateLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  _orderCreateLocks.set(key, tail);
  tail.then(() => { if (_orderCreateLocks.get(key) === tail) _orderCreateLocks.delete(key); });
  return run;
}

// SEPOS-AUDIT-001 — shared dine-in order creation for the reservation SEAT and
// WALK-IN endpoints, which used to INSERT orders directly and so bypassed the
// SEPOS-GHOST-001 mutex + dedupe (a double-tapped "Seat" on two devices still
// spawned twin open orders on the same table). Uses the SAME lock keyspace as
// POST /api/orders, so seat/walk-in/table-open races all serialise together.
async function openDineInOrderDeduped({ tableId, covers, staffId }) {
  return runExclusive(`order-create:table:${tableId}`, async () => {
    const existing = await pool.query(
      `SELECT o.id
         FROM orders o
        WHERE o.table_id = $1 AND o.status = 'open'
          AND (o.order_type IS NULL OR o.order_type = 'dine_in')
        ORDER BY CASE WHEN EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id) THEN 1 ELSE 0 END DESC,
                 o.id DESC
        LIMIT 1`,
      [tableId]
    );
    if (existing.rows[0]) {
      const full = await pool.query('SELECT * FROM orders WHERE id = $1', [existing.rows[0].id]);
      return { order: full.rows[0], reused: true };
    }
    await ensureOpenSession(); // SEPOS-AUTO-SESSION-001 — first sale opens the shift
    const ins = await pool.query(
      `INSERT INTO orders (table_id, staff_id, status, covers, opened_at)
       VALUES ($1, $2, 'open', $3, NOW()) RETURNING *`,
      [tableId, staffId || null, covers || 1]
    );
    await offlineQueue.enqueue('create_order', {
      localOrderId: ins.rows[0].id, table_id: tableId,
      covers: covers || 1, staff_id: staffId || null,
    });
    return { order: ins.rows[0], reused: false };
  });
}

app.post('/api/orders', requireActiveSubscription, requireValidLicense, async (req, res) => {
  try {
    const { table_id, covers, staff_id, order_type } = req.body;
    // SEPOS-045 — counter orders (and any tableless mode) skip the table
    // status flip and don't enforce covers.
    const type = order_type === 'counter' || order_type === 'takeaway'
      ? order_type : 'dine_in';

    await ensureOpenSession(resolveRestaurantId(req)); // SEPOS-AUTO-SESSION-001

    // SEPOS-GHOST-001 — de-duplicate a double-tapped table-open. A dine-in table
    // is single-bill by nature, so a second create on a table that already has an
    // open dine-in order should return that SAME order, not spawn an empty twin.
    // Takeaway/counter legitimately run several concurrent orders on one pseudo-
    // table, so they always create a fresh order (keyed uniquely to avoid a lock).
    const dedupe = type === 'dine_in' && table_id;
    const lockKey = dedupe
      ? `order-create:table:${table_id}`
      : `order-create:new:${staff_id || ''}:${table_id || 'none'}`;

    const out = await runExclusive(lockKey, async () => {
      if (dedupe) {
        // Prefer an existing open order that already has items, then the newest.
        // SEPOS-QR-PAY-REDO (verify pass, CRITICAL) — never hand the waiter a
        // customer's PREPAID QR order. The QR side already refuses to adopt a
        // waiter's bill; without the mirror rule the floor map handed the
        // waiter the newest open order on the table — often the QR one — they
        // rang £28 of food onto it, and the serve-time auto-close closed it as
        // "paid" because it was a QR order. £39.50 recorded, £11.50 taken.
        // A QR bill belongs to the customer who paid it; staff opening the
        // table get their own bill alongside it.
        // NB: order by a CASE/EXISTS expression, NOT a SELECT-list alias —
        // Postgres rejects an output alias used inside an ORDER BY expression
        // (SQLite tolerates it), so an aliased `(item_count > 0)` would 500 every
        // dine-in table-open on the cloud. This form runs on both backends.
        const existing = await pool.query(
          `SELECT o.id
             FROM orders o
            WHERE o.table_id = $1 AND o.status = 'open'
              AND (o.order_type IS NULL OR o.order_type = 'dine_in')
              AND COALESCE(o.source,'') <> 'qr'
            ORDER BY CASE WHEN EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id) THEN 1 ELSE 0 END DESC,
                     o.id DESC
            LIMIT 1`,
          [table_id]
        );
        if (existing.rows.length > 0) {
          await pool.query("UPDATE tables SET status = 'occupied' WHERE id = $1", [table_id]);
          return { id: existing.rows[0].id, success: true, reused: true };
        }
      }
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
      return { id: localOrderId, success: true };
    });
    res.json(out);
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
    const orderCheck = await client.query('SELECT id, status, source, payment_status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    // SEPOS-QR-PAY-REDO (verify pass, CRITICAL) — a QR order is the CUSTOMER's
    // prepaid bill; staff must never add to it (the floor map can route a
    // waiter onto it, and adding £40 of food to a £12 prepaid order then had
    // the auto-close either lose the £40 or double-tender it). Staff who want
    // to add to that table open their own bill. The QR flow itself does not use
    // this endpoint — it inserts items inside its own locked transaction — so
    // this only blocks the staff/floor path.
    if (orderCheck.rows[0].source === 'qr' && ['paid', 'mock'].includes(String(orderCheck.rows[0].payment_status || ''))) {   // SEPOS-QR-PAYLATER-001 — unpaid QR bills accept staff items
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This is a customer prepaid QR order — start a separate bill to add items to this table.', qrReadOnly: true });
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
      // SEPOS-SENTBY-001 — per-item override (offline replay) beats the
      // round-level name; NULL when neither is present (legacy clients).
      const sentBy = (item.sent_by || req.body.sent_by || '').trim().slice(0, 120) || null;
      const ins = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, cooking_started_at, item_name, dest_category_id, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [orderId, item.menu_item_id, item.quantity, unitPrice, item.notes || '', item.course || 1, item.item_note || '', isBar, firedAt, firedAt, itemName, destCategoryId, sentBy]
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
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [id]);
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
        'SELECT id, order_type, order_subtype, status, takeaway_status, source, payment_status, table_id FROM orders WHERE id = $1',
        [item.order_id]
      );
      const order = orderRes.rows[0];
      // SEPOS-QR-ORDER-001 — a QR order was PAID before it fired, so once the
      // food runner ticks the last item served there is nothing left to do:
      // close the bill right here (payments were recorded at order time) and
      // free the table if it holds no other open order.
      if (order && order.source === 'qr' && order.status === 'open'
          && (order.payment_status === 'paid' || order.payment_status === 'mock')) {
        const remainingQr = await pool.query(
          `SELECT COUNT(*) AS n FROM order_items
            WHERE order_id = $1 AND voided = 0 AND status <> 'served'`,
          [item.order_id]);
        // "Everything served" is NOT "everything paid for". The adoption rule
        // above should mean a QR order only ever holds prepaid rounds, but this
        // is the money check — if anything ever reaches the bill by another
        // route, it must NOT be closed away silently. Leave it open, tell the
        // log, and let staff take the balance.
        const cover = await pool.query(
          `SELECT COALESCE((SELECT SUM(amount) FROM payments
                             WHERE order_id = $1 AND COALESCE(method,'') <> 'cancelled'), 0) AS paid,
                  COALESCE((SELECT ${ORDER_TOTAL_EXPR} FROM order_items
                             WHERE order_id = $1 AND voided = 0), 0) AS total`,
          [item.order_id]);
        const paidAmt = Number(cover.rows[0]?.paid || 0);
        const dueAmt = Number(cover.rows[0]?.total || 0);
        const covered = paidAmt + 0.005 >= dueAmt;
        if (!covered) {
          console.warn(`[qr] order ${item.order_id} fully served but NOT settled (${paidAmt.toFixed(2)} of ${dueAmt.toFixed(2)}) — left open for staff to take the balance`);
        }
        if (covered && Number(remainingQr.rows[0]?.n || 0) === 0) {
          await pool.query(
            `UPDATE orders SET status='closed', closed_at=NOW(), service_charge=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1 AND status='open'`,
            [item.order_id]);
          if (order.table_id) {
            const others = await pool.query(
              `SELECT COUNT(*) AS n FROM orders WHERE table_id=$1 AND status='open'`, [order.table_id]);
            if (Number(others.rows[0]?.n || 0) === 0) {
              await pool.query(`UPDATE tables SET status='available' WHERE id=$1`, [order.table_id]);
            }
          }
          io.emit('order_closed', { order_id: Number(item.order_id) });
          console.log(`[qr] order ${item.order_id} fully served + prepaid → auto-closed`);
        }
      }
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
    if (await refuseQrMutation(orig.order_id, res)) return;   // round 6 — QR read-only

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
            status, is_fired, fired_at, cooking_started_at, served_at, voided, voided_at, void_reason,
            void_type, discount_type, discount_value)
         SELECT order_id, menu_item_id, item_name, $1, unit_price, notes, course, item_note,
            status, is_fired, fired_at, cooking_started_at, served_at, 1, CURRENT_TIMESTAMP, $2,
            $3, discount_type, discount_value
         FROM order_items WHERE id=$4 RETURNING id`,
        [qtyToVoid, reason, void_type || null, req.params.id]
      );
      ghostItemId = ghostRes.rows[0]?.id ?? null;
    } else {
      // Full void — existing behaviour. SEPOS-AUDIT-001: stamp WHEN the void
      // happened so the Z windows on the real instant, not orders.created_at.
      await pool.query('UPDATE order_items SET voided=1, voided_at=CURRENT_TIMESTAMP, void_reason=$1, void_type=$2 WHERE id=$3', [reason, void_type || null, req.params.id]);
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
        // SEPOS-AUDIT-001 — stamp a £0 'zero' payment row (like close-zero
        // does) and a £0 service snapshot, so this auto-closed order counts
        // identically in the Z, Reports and Bills instead of being a
        // no-payment shell that only the Z counted.
        await pool.query(`UPDATE orders SET status='closed', closed_at=NOW(), service_charge=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [item.order_id]);
        await pool.query(`INSERT INTO payments (order_id, amount, method) VALUES ($1, 0, 'zero')`, [item.order_id]);
        const orderRes = await pool.query('SELECT table_id FROM orders WHERE id=$1', [item.order_id]);
        if (orderRes.rows[0]) await freeTableIfEmpty(orderRes.rows[0].table_id);   // round 5
      }
    }
    // SEPOS-047c — return the ghost id so a desktop sync push can bind its
    // local ghost to this cloud ghost (prevents duplicate on next pull).
    res.json({ success: true, ghost_item_id: ghostItemId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-ITEM-MOVE-001 — move ONE line to another table (item rung on the
// wrong table; a guest moves taking their drink). Whole lines only in v1.
// Money guards: refuses when the source bill has ANY payment (part-paid split
// chaos), when either order is QR (prepaid, staff-read-only — same rule as
// every other mutation), and voided lines. The item's state travels
// untouched — a served item stays served, a fired course stays fired; the
// kitchen gets NO new ticket (nothing new to cook), the KDS card re-homes
// via the item_moved socket event.
app.put('/api/order-items/:id/move', async (req, res) => {
  try {
    const targetTableId = Number(req.body?.target_table_id);
    if (!targetTableId) return res.status(400).json({ error: 'target_table_id required' });

    const itemRes = await pool.query('SELECT * FROM order_items WHERE id = $1', [req.params.id]);
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (Number(item.voided) === 1) return res.status(400).json({ error: 'Voided items can\'t move.' });

    const srcRes = await pool.query('SELECT * FROM orders WHERE id = $1', [item.order_id]);
    const src = srcRes.rows[0];
    if (!src) return res.status(404).json({ error: 'Order not found' });
    if (src.status !== 'open') return res.status(409).json({ error: 'This bill is closed.' });
    if (await refuseQrMutation(src.id, res)) return;   // prepaid QR bills stay intact
    if (Number(src.table_id) === targetTableId) return res.status(400).json({ error: 'That is the same table.' });
    const payRes = await pool.query('SELECT COUNT(*) AS n FROM payments WHERE order_id = $1', [src.id]);
    if (Number(payRes.rows[0]?.n || 0) > 0) {
      return res.status(409).json({ error: 'This bill already has a payment on it — settle or amend it before moving items.' });
    }

    const tblRes = await pool.query('SELECT id, is_takeaway FROM tables WHERE id = $1', [targetTableId]);
    if (!tblRes.rows[0]) return res.status(404).json({ error: 'Target table not found' });

    // Existing open order on the target — same selection rule as seating:
    // never a QR order (a table can hold a waiter bill AND a prepaid QR bill).
    const tgtRes = await pool.query(
      `SELECT o.* FROM orders o
        WHERE o.table_id = $1 AND o.status = 'open' AND COALESCE(o.source,'') <> 'qr'
        ORDER BY CASE WHEN EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id) THEN 1 ELSE 0 END DESC,
                 o.id DESC
        LIMIT 1`, [targetTableId]);
    let target = tgtRes.rows[0] || null;
    let createdTarget = false;
    if (target) {
      const tPay = await pool.query('SELECT COUNT(*) AS n FROM payments WHERE order_id = $1', [target.id]);
      if (Number(tPay.rows[0]?.n || 0) > 0) {
        return res.status(409).json({ error: 'The bill on that table already has a payment on it — settle it first.' });
      }
    } else {
      const ins = await pool.query(
        `INSERT INTO orders (table_id, staff_id, status, covers, order_type, opened_at)
         VALUES ($1, $2, 'open', 1, 'dine_in', NOW()) RETURNING *`,
        [targetTableId, src.staff_id || null]);
      target = ins.rows[0];
      createdTarget = true;
      await pool.query(`UPDATE tables SET status = 'occupied' WHERE id = $1`, [targetTableId]);
    }

    await pool.query('UPDATE order_items SET order_id = $1, moved_from_order_id = $2 WHERE id = $3',
      [target.id, src.id, item.id]);

    // SEPOS-047c — BOTH totals through the shared expression, never a raw sum.
    for (const oid of [src.id, target.id]) {
      const t = await pool.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id=$1 AND voided=0`, [oid]);
      await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [t.rows[0].total || 0, oid]);
    }

    // Local till → replicate to cloud (translated by cloud ids on replay).
    await offlineQueue.enqueue('move_item', {
      localItemId: Number(item.id),
      target_table_id: targetTableId,
      localTargetOrderId: Number(target.id),
    });

    io.emit('item_moved', {
      item_id: Number(item.id), from_order_id: src.id, to_order_id: target.id,
      from_table_id: src.table_id, to_table_id: targetTableId,
    });
    io.emit('new_order_items', { order_id: target.id });   // KDS/strip refreshers

    res.json({ success: true, target_order_id: target.id, created_target: createdTarget });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/discount', async (req, res) => {
  try {
    if (await refuseQrMutation(req.params.id, res)) return;
    const { discount_type, discount_value, discount_reason } = req.body;
    // SEPOS-DISCOUNT-SCOPE-001 — 'food' / 'drink' limits the discount to that
    // side of the bill (categories.is_bar). Anything else (incl. 'all') → NULL.
    const discount_scope = ['food', 'drink'].includes(req.body.discount_scope) ? req.body.discount_scope : null;
    await pool.query('UPDATE orders SET discount_type=$1, discount_value=$2, discount_reason=$3, discount_scope=$4 WHERE id=$5', [discount_type, discount_value, discount_reason, discount_scope, req.params.id]);
    // SEPOS-AUDIT-001 — push to cloud on local installs (no-op on cloud);
    // without this the 5s cloud-wins pull reverted the discount within a tick.
    await offlineQueue.enqueue('apply_discount', {
      localOrderId: Number(req.params.id), discount_type, discount_value, discount_reason, discount_scope,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS — persist the Order screen's "Remove service charge" toggle per order.
// Was local React state only, so the Bill / receipt / splits re-added service
// charge from the global setting. Body: { no_service_charge: 0 | 1 }.
app.put('/api/orders/:id/service-charge', async (req, res) => {
  try {
    if (await refuseQrMutation(req.params.id, res)) return;
    const flag = req.body.no_service_charge ? 1 : 0;
    await pool.query('UPDATE orders SET no_service_charge = $1 WHERE id = $2', [flag, req.params.id]);
    // SEPOS-AUDIT-001 — CRITICAL on local tills: cloud defaults this flag to 0,
    // so without a push the next 5s pull re-added the service charge the
    // manager explicitly removed and the guest was overcharged.
    await offlineQueue.enqueue('update_order_flags', {
      localOrderId: Number(req.params.id), no_service_charge: flag,
    });
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
    const ord = await client.query('SELECT id, status, discount_type, discount_value, discount_scope FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const order = ord.rows[0];
    if (!order)                  { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (order.status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Order is ${order.status}` }); }

    // SEPOS-DISCOUNT-SCOPE-001 — is_bar joined so a food/drink-scoped discount
    // computes on the right base (a £ off drinks must not zero a food bill).
    const itemsRes = await client.query(
      `SELECT oi.unit_price, oi.quantity, oi.discount_type, oi.discount_value, oi.voided,
              COALESCE(c.is_bar, 0) AS is_bar
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         LEFT JOIN categories  c ON c.id  = COALESCE(mi.category_id, oi.dest_category_id)
        WHERE oi.order_id=$1`,
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
    const total = Math.max(0, subtotal - billDiscountAmountFor(order, itemsRes.rows));
    if (total > 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Bill total is £${total.toFixed(2)}, not £0 — use the normal pay flow` });
    }

    await client.query('INSERT INTO payments (order_id, amount, method) VALUES ($1, 0, $2)', [orderId, 'zero']);
    await client.query(`UPDATE orders SET status='closed', closed_at=NOW(), total=0, service_charge=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [orderId]);
    await client.query('COMMIT');
    // SEPOS-AUDIT-001 — close the CLOUD copy too (no-op on cloud installs);
    // otherwise it stayed 'open' forever and the pull reopened the local row.
    await offlineQueue.enqueue('close_zero', { localOrderId: Number(orderId) });
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
  // SEPOS-AUTO-SESSION-001 — belt-and-braces: a bill must never close outside
  // a shift window (covers orders created before this build shipped).
  if (!isCancel) await ensureOpenSession(resolveRestaurantId(req));
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
      // SEPOS-COMP-001 — a Complimentary settlement records £0 taken: the bill
      // closes, the value shows on the Z's comp line, takings untouched.
      const isComp = String(method) === 'Complimentary';
      if (!isComp && (!Number.isFinite(amt) || amt <= 0)) {
        return res.status(400).json({ error: 'Payment amount must be a positive number' });
      }
      paymentRows = [{ amount: isComp ? 0 : amt, method }];
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
    // SEPOS-AUDIT-001 — SELECT * (was id/status/table_id): the close now stamps
    // a service-charge snapshot, which needs total/discounts/order_type/
    // no_service_charge from this locked row.
    const ord = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
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
      await freeTableIfEmpty(order.table_id);   // round 5 — don't free a two-bill table
      // SEPOS-AUDIT-001 — this early-return path skipped the pay enqueue below,
      // so the cloud copy stayed 'open' and the pull reopened the cancelled
      // order on the till. Push the cancel too (no-op on cloud installs).
      await offlineQueue.enqueue('cancel_order', { localOrderId: Number(orderId) });
      return res.json({ success: true, cancelled: true });
    }

    // SEPOS-AUDIT-002 (verify pass, HIGH) — PREPAID bills. A QR round records
    // its tender at order time (pay-first), unlike online takeaway which
    // records nothing until the till closes it. The till's "✓ Confirm
    // collection · £X" button was built for takeaway and posts a full-value
    // payment here, so closing a prepaid QR bill recorded the money a SECOND
    // time (£78.50 of food showing £157.00 of tenders in the simulation).
    //
    // Deliberately NOT a separate close path: an earlier attempt forked one and
    // silently skipped the service-charge snapshot and the post-commit
    // bookkeeping. Here we only skip the duplicate INSERT and let the single
    // close path run exactly as it always has. The cloud runs this same code,
    // so the queued pay_order replay is suppressed there too — no duplicate on
    // either side.
    let suppressTender = false;
    if (!isCancel && order.status === 'open') {
      const already = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS paid FROM payments
          WHERE order_id = $1 AND COALESCE(method,'') <> 'cancelled'`, [orderId]);
      const alreadyPaid = Number(already.rows[0]?.paid || 0);
      if (alreadyPaid > 0 && alreadyPaid + 0.005 >= Number(order.total || 0)) {
        suppressTender = true;
        console.log(`[pay] order ${orderId} already settled (£${alreadyPaid.toFixed(2)}) — closing without a duplicate tender`);
      }
    }

    // Double-charge guard — only an OPEN bill can be paid.
    if (order.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This bill has already been paid.', alreadyPaid: true });
    }

    if (!suppressTender) {
      for (const p of paymentRows) {
        await client.query('INSERT INTO payments (order_id, amount, method) VALUES ($1,$2,$3)', [orderId, p.amount, p.method]);
      }
    }
    // SEPOS-AUDIT-001 — snapshot the service charge AT CLOSE with the rate in
    // force right now. Reports/Z used to re-derive historical bills from
    // TODAY'S settings, so changing the rate (12.5% → 10%) silently rewrote
    // every past total. Legacy rows (service_charge NULL) still derive.
    let closeServiceCharge = 0;
    try {
      const scRes = await client.query(
        `SELECT key, value FROM settings WHERE key IN ('service_charge_enabled','service_charge_rate','service_charge_percent')`);
      const scCfg = {}; for (const r of scRes.rows) scCfg[r.key] = r.value;
      const scOn = String(scCfg.service_charge_enabled ?? 'true') !== '0' && String(scCfg.service_charge_enabled ?? 'true') !== 'false';
      const scPct = Number(scCfg.service_charge_rate ?? scCfg.service_charge_percent ?? 12.5) || 0;
      // SEPOS-DISCOUNT-SCOPE-001 — a food/drink-scoped discount's £ depends on
      // the items, not the whole total; compute it here so the service-charge
      // snapshot is taken on the right base.
      let discOverride = null;
      if (Number(order.discount_value) > 0 && (order.discount_scope === 'food' || order.discount_scope === 'drink')) {
        const scopedItems = await client.query(
          `SELECT oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value, oi.voided,
                  COALESCE(c.is_bar, 0) AS is_bar
             FROM order_items oi
             LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
             LEFT JOIN categories  c ON c.id  = COALESCE(mi.category_id, oi.dest_category_id)
            WHERE oi.order_id = $1`, [orderId]);
        discOverride = billDiscountAmountFor(order, scopedItems.rows);
      }
      closeServiceCharge = Number(serviceChargeForOrder({ ...order, service_charge: null }, scOn, scPct, discOverride).toFixed(2));
      if (String(method) === 'Complimentary') closeServiceCharge = 0; // SEPOS-COMP-001 — nothing is charged on a comped bill
    } catch { closeServiceCharge = 0; }
    await client.query(`UPDATE orders SET status='closed', closed_at=NOW(), service_charge=$2, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [orderId, closeServiceCharge]);
    await client.query('COMMIT');

    // ---- post-commit side effects (the order is now closed) ----
    const tableId = order.table_id;
    if (tableId) {
      // Verify pass (SPLIT) — a table can now hold more than one open order (a
      // waiter bill alongside a customer's QR bill). Free it only when nothing
      // else is still open on it, same rule the QR auto-close uses. Without
      // this, paying one bill wrongly marked the table available while the
      // other party was still eating.
      const stillOpen = await pool.query(
        "SELECT COUNT(*) AS n FROM orders WHERE table_id=$1 AND status='open'", [tableId]);
      if (Number(stillOpen.rows[0]?.n || 0) === 0) {
        await pool.query("UPDATE tables SET status='available' WHERE id=$1", [tableId]);
      }
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
            // round 6 — a linked partner table can independently hold its own
            // open order; free it only if it doesn't (same rule as everywhere).
            if (row.id && row.id !== tableId) await freeTableIfEmpty(row.id);
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
      pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id=$1`, [req.params.id]),
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

// SEPOS-SEC-LOGIN — brute-force lockout for the PIN login. The till login is a
// PUBLIC page and the PIN is 4 digits; previously this endpoint had NO throttle
// at all → unlimited guesses. Failure-based: 8 wrong PINs in 15 min from one IP
// → that IP is locked 15 min. A good login clears the counter (legit staff who
// know their PIN are unaffected). Email login stays as the escape hatch.
const _loginFails = new Map();
const _FAIL_MAX = 8, _FAIL_WIN = 15 * 60 * 1000;
// Hard stop. 8 wrong PINs starts slowing you down; 60 in the window is not
// a restaurant having a bad night, it's enumeration — and a venue that hits
// it can still sign in with email.
const _FAIL_HARD = 60;
function _loginLockedOut(ip) {
  const now = Date.now();
  const arr = (_loginFails.get(ip) || []).filter((t) => now - t < _FAIL_WIN);
  _loginFails.set(ip, arr);
  if (_loginFails.size > 5000) _loginFails.clear();
  return arr.length >= _FAIL_MAX;
}
function _recordLoginFail(ip) { const a = _loginFails.get(ip) || []; a.push(Date.now()); _loginFails.set(ip, a); }
// F16 — live failures in the window, driving the escalating delay above.
function _loginFailCount(ip) {
  const now = Date.now();
  const arr = (_loginFails.get(ip) || []).filter((t) => now - t < _FAIL_WIN);
  _loginFails.set(ip, arr);
  if (_loginFails.size > 5000) _loginFails.clear();
  return arr.length;
}
const _WEAK_PINS = new Set(['1234', '0000', '1111', '2222', '3333', '4444', '5555', '6666',
  '7777', '8888', '9999', '4321', '1212', '2580', '0123', '123456', '000000', '111111']);
function _isWeakPin(p) { return _WEAK_PINS.has(String(p || '')); }

app.post('/api/staff/login', async (req, res) => {
  try {
    // SEPOS-DEVICE-AUTH-001 — on cloud tills with the gate switched on, only
    // email-authorised devices may reach the PIN check at all. Local/Electron
    // installs never enforce (deviceAuthRequired is false in local mode).
    if (await deviceAuthRequired()) {
      if (!await deviceTokenValid(req.get('x-device-token'))) {
        return res.status(401).json({ error: 'This device needs authorisation before staff can sign in.', device_auth_required: true });
      }
    }
    const { pin } = req.body;
    // F16 — with trust proxy set this is the venue's real address, but every
    // till in a restaurant shares it, so a HARD lockout would still take the
    // whole floor down when one member of staff fat-fingers their PIN. Use an
    // escalating DELAY instead: brute force slows to a crawl, while staff who
    // eventually type the right PIN always get in. A correct PIN clears it.
    // Verify pass (MEDIUM) — the delay alone was not a rate limit: an attacker
    // can run guesses in parallel, so a per-request sleep costs them nothing.
    // Keep the delay (it protects real staff from being locked out for a typo)
    // but restore a hard ceiling far above any plausible fat-finger rate.
    // req.ip is only trustworthy because `trust proxy` is set to ONE hop, so a
    // client-supplied X-Forwarded-For cannot displace the real edge address.
    const ip = 'ip:' + (req.ip || '');
    const fails = _loginFailCount(ip);
    if (fails >= _FAIL_HARD) {
      return res.status(429).json({ error: 'Too many failed attempts from this connection. Wait a few minutes, or use “Sign in with email”.' });
    }
    if (fails >= _FAIL_MAX) {
      await new Promise(r => setTimeout(r, Math.min(4000, 250 * (fails - _FAIL_MAX + 1))));
    }
    const result = await pool.query('SELECT * FROM staff WHERE pin=$1 AND is_active=1', [pin]);
    const staff = result.rows[0];
    if (!staff) { _recordLoginFail(ip); return res.status(401).json({ error: 'Invalid PIN' }); }
    _loginFails.delete(ip); // correct PIN — clear the counter for this venue
    // SEPOS-047a — PIN login now issues the same HMAC session token as
    // email login (signToken below), so staff-gated endpoints can verify
    // the caller. Old clients ignore the extra fields harmlessly.
    const exp = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const token = signToken({ sid: staff.id, name: staff.name, role: staff.role, exp });
    // SEPOS-SEC-LOGIN — an operator still on a weak/default PIN (the seeded 1234)
    // must set a real one before using the till; the public default can't persist.
    const must_change_pin = _isWeakPin(pin) && ['admin', 'manager', 'supervisor'].includes(staff.role);
    // SEPOS-STAFF-PERMS-001 — per-staff permissions travel with the session so
    // the client can honour "can give discount / can redeem deposit" for a
    // non-manager the owner has trusted.
    res.json({ id: staff.id, name: staff.name, role: staff.role, token, expires_at: exp, must_change_pin, can_discount: staff.can_discount ? 1 : 0, can_redeem_deposit: staff.can_redeem_deposit ? 1 : 0, can_void: staff.can_void ? 1 : 0, can_close_z: staff.can_close_z ? 1 : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-SEC-LOGIN — POST /api/staff/change-pin { new_pin } — signed-in staff
// set their OWN PIN. Used by the forced change off the default. Plaintext PIN
// (matches the login query) + UNIQUE constraint, so validate + dedupe here.
app.post('/api/staff/change-pin', requireStaffAuth(), async (req, res) => {
  try {
    const newPin = String((req.body || {}).new_pin || '').trim();
    if (!/^\d{4,6}$/.test(newPin)) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
    if (_isWeakPin(newPin)) return res.status(400).json({ error: 'That PIN is too easy to guess — pick another' });
    const myId = req.staffAuth && req.staffAuth.sid;
    if (!myId) return res.status(401).json({ error: 'not authenticated' });
    const dup = await pool.query('SELECT id FROM staff WHERE pin=$1 AND id<>$2', [newPin, myId]);
    if (dup.rows[0]) return res.status(409).json({ error: 'That PIN is already in use — choose another' });
    await pool.query('UPDATE staff SET pin=$1 WHERE id=$2', [newPin, myId]);
    res.json({ ok: true });
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
  // SEPOS-061b — a per-BOOT random secret is right for a cloud deploy that
  // forgot its env var (tokens unforgeable, sessions reset on redeploy), but
  // on a LOCAL till it meant EVERY app restart silently killed every stored
  // login on the device: the client kept sending the dead token and every
  // gated save answered "sign out and sign in again" (Korakot's two-week
  // Fern/demo-till chase, 17 Aug — proven by replaying the device's stored
  // token against its own freshly-restarted server: 401). Local installs now
  // persist a per-install random secret next to the SQLite DB, so staff
  // sessions survive restarts and updates. Still never the public default,
  // still random per install; file is 0600.
  let persisted = null;
  if (process.env.DB_MODE === 'local' && process.env.SQLITE_PATH) {
    const fsSync = require('fs');
    const secretFile = path.join(path.dirname(process.env.SQLITE_PATH), '.auth-secret');
    try {
      if (fsSync.existsSync(secretFile)) {
        const s = fsSync.readFileSync(secretFile, 'utf8').trim();
        if (s && s !== DEFAULT_AUTH_SECRET && s.length >= 32) persisted = s;
      }
      if (!persisted) {
        persisted = crypto.randomBytes(32).toString('hex');
        fsSync.writeFileSync(secretFile, persisted, { mode: 0o600 });
      }
    } catch (e) {
      console.warn('[auth] could not persist local auth secret — sessions will reset on restart:', e.message);
      persisted = null;
    }
  }
  AUTH_SECRET = persisted || crypto.randomBytes(32).toString('hex');
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
    // SEPOS-OFFICE-001 — this endpoint is the Back Office front door on a
    // public URL; give it the same brute-force treatment as the PIN login
    // (shared counter: guessing either way slows both).
    const ip = 'ip:' + (req.ip || '');
    const fails = _loginFailCount(ip);
    if (fails >= _FAIL_HARD) {
      return res.status(429).json({ error: 'Too many failed attempts from this connection. Please wait a few minutes.' });
    }
    if (fails >= _FAIL_MAX) {
      await new Promise(r2 => setTimeout(r2, Math.min(4000, 250 * (fails - _FAIL_MAX + 1))));
    }
    const r = await pool.query(
      `SELECT * FROM staff WHERE LOWER(email) = LOWER($1) AND is_active = 1`,
      [String(email).trim()]
    );
    const staff = r.rows[0];
    if (!staff || !staff.password_hash || !verifyPassword(password, staff.password_hash)) {
      _recordLoginFail(ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    _loginFails.delete(ip);
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

// ─── SEPOS-DEVICE-AUTH-001 — email-authorised devices for public till URLs ──
// A cloud till URL guarded only by 4-digit PINs is too thin once the link is
// public. When settings.require_device_auth='1' (per tenant, default OFF) and
// this is a CLOUD instance, /api/staff/login demands an x-device-token from a
// device that verified by email: an active admin/manager/supervisor staff
// email, or the SiamEPOS support allowlist (SUPPORT_ACCESS_EMAILS env).
// Local/Electron installs and LAN tablets talk to local servers and are never
// gated. Reuses the magic-link pattern: sha256-stored, single-use links,
// 180-day device tokens.
const SUPPORT_ACCESS_EMAILS = String(process.env.SUPPORT_ACCESS_EMAILS || 'kongponsrisiri@gmail.com,info@siamepos.co.uk')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

async function deviceAuthRequired() {
  if (process.env.FORCE_DEVICE_AUTH === '1') return true;   // test hook
  if (String(process.env.DB_MODE || '').toLowerCase() === 'local') return false;
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'require_device_auth'`);
    return String(r.rows[0]?.value || '') === '1';
  } catch { return false; }
}

async function deviceTokenValid(raw) {
  if (!raw) return false;
  const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
  const r = await pool.query(
    `SELECT id, expires_at FROM trusted_devices WHERE token_hash = $1`, [hash]);
  const row = r.rows[0];
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  pool.query(`UPDATE trusted_devices SET last_seen = NOW() WHERE id = $1`, [row.id]).catch(() => {});
  return true;
}

app.post('/api/device/request-auth', async (req, res) => {
  try {
    if (!await deviceAuthRequired()) return res.json({ ok: true, not_required: true });
    const email = String((req.body || {}).email || '').trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email is required' });
    if (!_linkReqAllowed('dev:' + (req.ip || '') + '|' + email.toLowerCase())) {
      return res.status(429).json({ error: 'Too many requests — check your inbox (and spam), or wait a few minutes.' });
    }
    const ok = { ok: true, message: 'If that email can authorise this till, a link is on its way.' };
    let allowed = SUPPORT_ACCESS_EMAILS.includes(email.toLowerCase());
    if (!allowed) {
      const r = await pool.query(
        `SELECT id, role FROM staff WHERE LOWER(email) = LOWER($1) AND is_active = 1`, [email]);
      allowed = !!(r.rows[0] && ['admin', 'manager', 'supervisor'].includes(r.rows[0].role));
    }
    if (!allowed) return res.json(ok);   // same reply — no enumeration

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO device_links (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, email.toLowerCase(), expiresAt]);

    const base = (req.get('origin') || process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const link = `${base}/?device_token=${token}`;
    const name = process.env.RESTAURANT_NAME || 'SiamEPOS';
    const { sendBrevoEmail } = require('./services/emailService');
    const isProd = process.env.NODE_ENV === 'production';
    try {
      await sendBrevoEmail(email, `Authorise this device for ${name}`,
        `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#0D1B3E;">
          <h2 style="color:#0D1B3E;">Authorise a till device</h2>
          <p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#334155;">
            Someone (hopefully you) asked to use the ${name} till on a new device.
            Tap the button ON THAT DEVICE to authorise it. The link works once and expires in 15 minutes.
          </p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${link}" style="background:#C9A84C;color:#0D1B3E;font-family:system-ui,sans-serif;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block;">Authorise this device</a>
          </p>
          <p style="font-family:system-ui,sans-serif;font-size:12px;color:#94a3b8;">
            If this wasn't you, ignore this email — the device stays locked out.
          </p>
        </div>`);
    } catch (mailErr) {
      if (isProd) throw mailErr;
      console.error('[device-auth] dev: mail send failed (link still echoed):', mailErr.message);
    }
    if (!isProd) return res.json({ ...ok, dev_link: link });
    res.json(ok);
  } catch (err) {
    console.error('[device-auth] request', err.message);
    res.status(500).json({ error: 'Could not send the authorisation link.' });
  }
});

app.post('/api/device/consume-auth', async (req, res) => {
  try {
    const token = String((req.body || {}).token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token required' });
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    // Atomic single-use consume, same pattern as login_links.
    const r = await pool.query(
      `UPDATE device_links SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING email`, [hash]);
    const row = r.rows[0];
    if (!row) return res.status(400).json({ error: 'This link has expired or was already used — request a new one.' });
    const deviceToken = crypto.randomBytes(48).toString('hex');
    const deviceHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
    const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO trusted_devices (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
      [deviceHash, row.email, expiresAt]);
    console.log(`[device-auth] device authorised for ${row.email}`);
    res.json({ ok: true, device_token: deviceToken, expires_at: expiresAt });
  } catch (err) {
    console.error('[device-auth] consume', err.message);
    res.status(500).json({ error: 'Could not authorise this device.' });
  }
});

// ─── SEPOS-OFFICE-001 — owner Back Office magic-link sign-in ────────────────
// The owner types their email on <till-url>/#office; we email a one-time link
// that signs them straight in (15-min link, 14-day session). Only the SHA-256
// of the token is stored, and consuming is an atomic UPDATE so a link can
// never be used twice. Password login stays as the fallback (and the only
// option until the tenant has BREVO_API_KEY).
const _linkReqs = new Map();   // ip+email → timestamps (5 per 15 min)
function _linkReqAllowed(key) {
  const now = Date.now();
  const arr = (_linkReqs.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (_linkReqs.size > 5000) _linkReqs.clear();
  if (arr.length >= 5) { _linkReqs.set(key, arr); return false; }
  arr.push(now); _linkReqs.set(key, arr); return true;
}

app.post('/api/auth/request-login-link', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email is required' });
    const ip = 'ip:' + (req.ip || '');
    if (!_linkReqAllowed(ip + '|' + email.toLowerCase())) {
      return res.status(429).json({ error: 'Too many link requests — check your inbox (and spam), or wait a few minutes.' });
    }
    if (!process.env.BREVO_API_KEY) {
      return res.status(400).json({ error: 'Email sign-in links are not set up for this restaurant yet — sign in with your password below.' });
    }
    // Same reply whether or not the email exists — no account enumeration.
    const ok = { ok: true, message: 'If that email has Back Office access, a sign-in link is on its way.' };
    const r = await pool.query(
      `SELECT id, name, email, role FROM staff WHERE LOWER(email) = LOWER($1) AND is_active = 1`,
      [email]
    );
    const staff = r.rows[0];
    if (!staff || !['admin', 'manager', 'supervisor'].includes(staff.role)) return res.json(ok);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO login_links (token_hash, staff_id, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, staff.id, expiresAt]
    );

    // The link points back at the page the owner is standing on (the tenant's
    // own till/office URL), falling back to the configured public address.
    const base = (req.get('origin') || process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const link = `${base}/#office?login_token=${token}`;
    const spaName = process.env.RESTAURANT_NAME || 'SiamEPOS';
    const { sendBrevoEmail } = require('./services/emailService');
    const isProd = process.env.NODE_ENV === 'production';
    try {
    await sendBrevoEmail(
      staff.email,
      `Your ${spaName} Back Office sign-in link`,
      `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#0D1B3E;">
        <h2 style="color:#0D1B3E;">Sign in to ${spaName}</h2>
        <p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#334155;">
          Tap the button to open your Back Office on this device. The link works once and expires in 15 minutes.
        </p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${link}" style="background:#C9A84C;color:#0D1B3E;font-family:system-ui,sans-serif;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block;">Open Back Office</a>
        </p>
        <p style="font-family:system-ui,sans-serif;font-size:12px;color:#94a3b8;">
          If you didn't request this, ignore this email — no one can sign in without the link.
        </p>
      </div>`
    );
    } catch (mailErr) {
      // In production the owner must know the email never left; in dev the
      // echoed link below is the whole point, so a failed send is tolerable.
      if (isProd) throw mailErr;
      console.error('[office] dev: mail send failed (link still echoed):', mailErr.message);
    }
    // Outside production the link is echoed so the flow can be wire-tested
    // without a mailbox.
    if (!isProd) return res.json({ ...ok, dev_link: link });
    res.json(ok);
  } catch (err) {
    console.error('[office] request-login-link', err.message);
    res.status(500).json({ error: 'Could not send the link — try password sign-in.' });
  }
});

app.post('/api/auth/consume-login-link', async (req, res) => {
  try {
    const token = String((req.body || {}).token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });
    const ip = 'ip:' + (req.ip || '');
    if (_loginFailCount(ip) >= _FAIL_HARD) {
      return res.status(429).json({ error: 'Too many attempts from this connection.' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const nowIso = new Date().toISOString();
    const r = await pool.query(
      `UPDATE login_links SET used_at = CURRENT_TIMESTAMP
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING staff_id`,
      [tokenHash, nowIso]
    );
    if (!r.rows[0]) {
      _recordLoginFail(ip);
      return res.status(401).json({ error: 'This sign-in link has expired or was already used — request a new one.' });
    }
    const sr = await pool.query(`SELECT id, name, role FROM staff WHERE id = $1 AND is_active = 1`, [r.rows[0].staff_id]);
    const staff = sr.rows[0];
    if (!staff) return res.status(401).json({ error: 'This account is no longer active.' });
    const exp = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const token2 = signToken({ sid: staff.id, name: staff.name, role: staff.role, exp });
    res.json({ token: token2, expires_at: exp, staff: { id: staff.id, name: staff.name, role: staff.role } });
  } catch (err) {
    console.error('[office] consume-login-link', err.message);
    res.status(500).json({ error: 'server error' });
  }
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
    const result = await pool.query('SELECT id, name, role, is_active, created_at, start_date, notes, employment_status, can_discount, can_redeem_deposit, can_void, can_close_z, email FROM staff ORDER BY name');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', requireStaffAuthOrSyncSecret(['admin', 'manager']), async (req, res) => {
  if (await maybeForwardStaffWriteToCloud(req, res)) return;
  try {
    const { name, pin, role, start_date, notes, employment_status, can_discount, can_redeem_deposit, can_void, can_close_z } = req.body;
    // SEPOS-047k — PINs are UNIQUE (staff_pin_key / staff.pin UNIQUE). A
    // collision used to surface as a raw 500 "duplicate key value violates
    // unique constraint" → the Staff screen just said "Save failed!" with
    // no clue. Pre-check and return a clear, actionable 409 instead.
    const dup = await pool.query('SELECT name FROM staff WHERE pin = $1', [pin]);
    if (dup.rows[0]) {
      return res.status(409).json({ error: `PIN ${pin} is already used by ${dup.rows[0].name}. Please choose a different 4-digit PIN.` });
    }
    const result = await pool.query('INSERT INTO staff (name, pin, role, start_date, notes, employment_status, can_discount, can_redeem_deposit, can_void, can_close_z, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [name, pin, role, start_date || null, notes || null, employment_status || 'active', can_discount ? 1 : 0, can_redeem_deposit ? 1 : 0, can_void ? 1 : 0, can_close_z ? 1 : 0, (String(req.body.email || '').trim().toLowerCase() || null)]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) {
    if (/unique|duplicate/i.test(err.message || '')) {
      return res.status(409).json({ error: `That PIN is already used by another staff member. Please choose a different 4-digit PIN.` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', requireStaffAuthOrSyncSecret(['admin', 'manager']), async (req, res) => {
  if (await maybeForwardStaffWriteToCloud(req, res)) return;
  try {
    const { name, pin, role, is_active, start_date, notes, employment_status, can_discount, can_redeem_deposit, can_void, can_close_z } = req.body;
    const cd = can_discount ? 1 : 0, crd = can_redeem_deposit ? 1 : 0, cv = can_void ? 1 : 0, cz = can_close_z ? 1 : 0;
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
           employment_status = $7,
           can_discount = $8,
           can_redeem_deposit = $9,
           can_void = $10,
           can_close_z = $11
         WHERE id = $12`,
        [name, pin, role, activeParam, start_date || null, notes || null, employment_status || 'active', cd, crd, cv, cz, req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE staff SET
           name = $1,
           role = $2,
           is_active = COALESCE($3::int, is_active),
           start_date = $4,
           notes = $5,
           employment_status = $6,
           can_discount = $7,
           can_redeem_deposit = $8,
           can_void = $9,
           can_close_z = $10
         WHERE id = $11`,
        [name, role, activeParam, start_date || null, notes || null, employment_status || 'active', cd, crd, cv, cz, req.params.id]
      );
    }
    // Email updates separately so tills that don't send the field can never
    // clobber it (owner sign-in links + device authorisation match on it).
    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
      const emailParam = String(req.body.email || '').trim().toLowerCase() || null;
      await pool.query('UPDATE staff SET email = $1 WHERE id = $2', [emailParam, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    if (/unique|duplicate/i.test(err.message || '')) {
      return res.status(409).json({ error: `That PIN is already used by another staff member. Please choose a different 4-digit PIN.` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', requireStaffAuthOrSyncSecret(['admin', 'manager']), async (req, res) => {
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
    // SEPOS-PRINT-UNIFY-001 fix — overlay the Network Printers list onto the
    // legacy printer_<role>_ip keys the clients read. Without this, a printer
    // configured ONLY via the unified list (roles + ⭐ default) never reaches
    // the client, so orders/bills silently don't print even though a manual
    // Test (which hits the IP directly) works. The print endpoints already do
    // this server-side, but the client gates the print call on these keys, so
    // GET must expose them too.
    await applyPrinterRouting(settings);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const updates = req.body;
    // SEPOS-NAV-HIDE-001 — home guard, server-side: the till always needs
    // Tables or Counter to land on. The Settings UI refuses this too, but a
    // stale client (or a raw API call) must not be able to strand every till
    // with no home tab. Checked against the EFFECTIVE result (payload value
    // if present, stored value otherwise — a payload may carry one key only).
    if ('nav_show_tables' in updates || 'nav_show_counter' in updates) {
      const effective = async (key) => {
        if (key in updates) return String(updates[key]);
        const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
        return String(r.rows[0]?.value ?? '1');
      };
      if ((await effective('nav_show_tables')) === '0' && (await effective('nav_show_counter')) === '0') {
        return res.status(400).json({ error: 'The till needs at least one home screen — Tables and Counter cannot both be hidden.' });
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    }
    _cfdBrandCache.at = 0; // SEPOS-CFD-002 — logo/colour edits reach the customer display immediately

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
    let resolvedLabel = '';
    let resolvedType  = 'dine_in';
    let resolvedCustomer = customer_name || '';
    // Always resolve when we have the order — the table NAME only lives
    // server-side, and a client-sent bare number must not skip it.
    if (order_id) {
      const r = await pool.query(
        `SELECT o.id, o.order_type, o.customer_name, t.table_number, t.name AS table_label, t.is_takeaway AS table_is_takeaway
         FROM orders o LEFT JOIN tables t ON t.id = o.table_id
         WHERE o.id = $1`, [order_id]
      ).catch(() => ({ rows: [] }));
      const o = r.rows[0];
      if (o) {
        resolvedTable    = resolvedTable || o.table_number || '';
        resolvedLabel    = (o.table_label && String(o.table_label).trim()) || '';
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
        order_id, table_number: resolvedTable, table_label: resolvedLabel, order_type: resolvedType,
        customer_name: resolvedCustomer, message: text, waiter_name: waiter_name || '',
      });
      printed = true;
    } catch (err) {
      console.warn('[kitchen-message] print failed:', err.message);
    }

    io.emit('kitchen_message', {
      order_id,
      table_number: resolvedTable,
      table_label:  resolvedLabel,
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

// SEPOS-KITCHEN-MSG-002 — attach a kitchen note to an ORDER so it prints at the
// BOTTOM of that order's kitchen ticket (buildFullKitchenTicket already renders
// order.customer_note in big bold) instead of a lone standalone slip. Written
// local-first — that's what the kitchen-print endpoints read from the DB — and
// the 5s active-order pull won't clobber it because it drops null cloud values.
// Best-effort cloud push + socket so reprints, other devices and the KDS agree.
app.put('/api/orders/:id/note', async (req, res) => {
  try {
    const note = String(req.body?.note ?? '').slice(0, 200);
    await pool.query('UPDATE orders SET customer_note = $1 WHERE id = $2', [note, req.params.id]);
    io.emit('order_note_updated', { order_id: Number(req.params.id), note });
    try {
      const archiveService = require('./services/archiveService');
      if (archiveService.isLocalInstall() && process.env.CLOUD_API_URL) {
        const cloudId = await localOrderCloudId(req.params.id);
        if (cloudId) {
          const headers = { 'Content-Type': 'application/json' };
          if (process.env.SYNC_SECRET) headers['x-sync-secret'] = process.env.SYNC_SECRET;
          fetch(`${process.env.CLOUD_API_URL}/api/orders/${cloudId}/note`, {
            method: 'PUT', headers, body: JSON.stringify({ note }),
            signal: AbortSignal.timeout(6000),
          }).catch(e => console.warn('[order-note] cloud push failed:', e.message));
        }
      }
    } catch (e) { console.warn('[order-note] push skipped:', e.message); }
    res.json({ success: true, note });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    // SEPOS-048 — "today" is the RESTAURANT's today, and the day runs from
    // the restaurant's midnight to the next one. The old `::date` bucketing
    // grouped by UTC day, so in BST an order closed 00:30 local counted on
    // the previous day's report (and after 11pm the default date was wrong).
    const tz = await restaurantTz();
    const date = req.query.date || dateInZone(new Date(), tz);
    const dayStart = zonedMidnightUtc(date, tz);
    if (!dayStart) return res.status(400).json({ error: 'Invalid date' });
    const nextYmd = new Date(Date.parse(`${date}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const dayEnd = zonedMidnightUtc(nextYmd, tz);
    // BUG-EPOS-005 (Nook): /reports/daily was reporting orders.total
    // (the bare subtotal) where /reports/summary was already reporting
    // payments.amount (the money actually taken, including 12.5%
    // service charge). Mirror the summary pattern so the two reports
    // agree to the penny.
    // SEPOS-AUDIT-001 — mirror SEPOS-REPREC-001's cancelled exclusion here too:
    // written-off bills were still counted in daily totals/order_count.
    const result = await pool.query(`SELECT orders.id, orders.total, orders.closed_at, orders.order_type, orders.customer_name, payments.method, payments.amount AS paid_amount, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN payments ON orders.id = payments.order_id LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='closed' AND orders.closed_at >= $1::timestamp AND orders.closed_at < $2::timestamp AND (payments.method IS NOT NULL OR orders.order_type = 'takeaway') AND (payments.method IS NULL OR payments.method != 'cancelled' AND COALESCE(payments.method,'') <> 'Complimentary' AND COALESCE(payments.method,'') NOT LIKE '%(mock)%') ORDER BY orders.closed_at DESC`, [dayStart.toISOString(), dayEnd.toISOString()]);
    const total = result.rows.reduce((sum, r) => sum + Number(r.paid_amount ?? r.total ?? 0), 0);
    // Dedupe order_count by orders.id — LEFT JOIN payments multiplies rows
    // on split-pay orders.
    const uniqueOrderIds = new Set(result.rows.map(r => r.id));
    res.json({ date, orders: result.rows, total_sales: total, order_count: uniqueOrderIds.size, ...splitByOrderType(result.rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-MENUPERF-001 — per-dish sales vs recipe cost for the Menu
// Performance report (Inventory → Cost & Sales → Print A4). Read-only
// aggregate: sold qty + revenue per dish over the range, joined to the
// dish's recipe cost_per_portion where a recipe exists. Line revenue
// honours per-item discounts; bill-level discounts and service charge are
// intentionally NOT allocated down to dishes (menu engineering wants the
// dish's own pricing performance). Dishes without recipes come back with
// cost NULL so the client can show "no recipe" rather than a fake margin.
app.get('/api/reports/menu-performance', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
      return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
    }
    // Verify pass — bucket by the restaurant's day like every other report, and
    // exclude cancelled/mock tenders so demo money and voided bills don't
    // inflate the item ranking.
    const mpTz = await restaurantTz();
    const mpFrom = zonedMidnightUtc(from, mpTz);
    const mpNext = new Date(Date.parse(`${to}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const mpTo = zonedMidnightUtc(mpNext, mpTz);
    if (!mpFrom || !mpTo) return res.status(400).json({ error: 'Invalid date range' });
    const r = await pool.query(`
      SELECT
        COALESCE(mi.id, 0)                              AS menu_item_id,
        COALESCE(mi.name, oi.item_name, 'Unknown item') AS name,
        COALESCE(c.name, 'Other')                       AS category,
        SUM(oi.quantity)                                AS qty,
        SUM(
          (oi.quantity * oi.unit_price)
          - CASE
              WHEN oi.discount_type = 'percent' THEN (oi.quantity * oi.unit_price) * (COALESCE(oi.discount_value,0) / 100.0)
              WHEN oi.discount_type = 'fixed'   THEN COALESCE(oi.discount_value,0)
              ELSE 0
            END
        )                                               AS revenue,
        MAX(rec.cost_per_portion)                       AS cost_per_portion
      FROM order_items oi
      JOIN orders o        ON o.id = oi.order_id
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      LEFT JOIN categories c  ON c.id  = mi.category_id
      LEFT JOIN recipes rec   ON rec.menu_item_id = mi.id
      WHERE o.status = 'closed' AND oi.voided = 0
        AND o.closed_at >= $1::timestamp AND o.closed_at < $2::timestamp
        AND ((o.order_type = 'takeaway' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (p.method = 'cancelled' OR p.method = 'Complimentary' OR COALESCE(p.method,'') LIKE '%(mock)%')))
             OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND COALESCE(p.method,'') <> 'cancelled' AND COALESCE(p.method,'') <> 'Complimentary' AND COALESCE(p.method,'') NOT LIKE '%(mock)%'))
      GROUP BY COALESCE(mi.id, 0), COALESCE(mi.name, oi.item_name, 'Unknown item'), COALESCE(c.name, 'Other')
      ORDER BY revenue DESC
    `, [mpFrom.toISOString(), mpTo.toISOString()]);
    res.json({ from, to, items: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    // Verify pass (MEDIUM) — bucket by the RESTAURANT's day like /reports/daily
    // and /reports/items. Leaving this on the UTC calendar day meant the Sales
    // tab and the Items tab of the same Reports screen disagreed after every
    // late service — worse than the original bug, because both look right.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
      return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
    }
    const sumTz = await restaurantTz();
    const sumFrom = zonedMidnightUtc(from, sumTz);
    const sumNext = new Date(Date.parse(`${to}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const sumTo = zonedMidnightUtc(sumNext, sumTz);
    if (!sumFrom || !sumTo) return res.status(400).json({ error: 'Invalid date range' });
    const sumFromIso = sumFrom.toISOString(), sumToIso = sumTo.toISOString();
    const [result, foodDrinkRes, voucherSoldRes, voucherRedeemedRes, settingsRes, compRes] = await Promise.all([
      // Korakot 2026-06-02: pull payments.amount as paid_amount so the
      // Reports tab can show what was actually collected (incl. service
      // charge) instead of the bare subtotal.
      // (verify pass: orders.service_charge added — without it in the SELECT,
      // serviceChargeForOrder saw undefined and silently fell back to deriving
      // from today's rate, defeating the snapshot.)
      pool.query(`SELECT orders.id, orders.total, orders.closed_at, orders.covers, orders.discount_value, orders.discount_type, orders.discount_scope, orders.order_type, orders.no_service_charge, orders.service_charge, orders.customer_name, payments.method, payments.amount AS paid_amount, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN payments ON orders.id = payments.order_id LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='closed' AND orders.closed_at >= $1::timestamp AND orders.closed_at < $2::timestamp AND (payments.method IS NOT NULL OR orders.order_type = 'takeaway') AND (payments.method IS NULL OR payments.method != 'cancelled' AND COALESCE(payments.method,'') <> 'Complimentary' AND COALESCE(payments.method,'') NOT LIKE '%(mock)%') ORDER BY orders.closed_at DESC`, [sumFromIso, sumToIso]),
      // SEPOS-REPREC-001 — a cancelled/void bill closes with a payment row
      // method='cancelled', £0. It collected nothing, so it must NOT count as a
      // sale or an order here — otherwise Trading's "Total Sales" (orders.total)
      // and "Orders" count outrun the Bills page (which already excludes them),
      // and the £0 'cancelled' line litters the Payment Methods list. Mirrors the
      // /api/bills filter so Trading, Bills and the Z report reconcile.
      // Korakot 2026-06-02: food vs drink split based on categories.is_bar.
      // Per-item discounts applied. Service charge + bill-level discounts
      // are handled separately above.
      // SEPOS-AUDIT-001 — per-order rows aggregated in JS with the bill-level
      // discount factor (like VAT), + written-off-bill exclusion, so Food/Drink
      // foots to total_sales on comp/write-off days. (Was a flat SUM that
      // ignored bill discounts and counted cancelled-payment bills.)
      pool.query(`
        SELECT oi.order_id, oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value,
               COALESCE(c.is_bar, 0) AS is_bar,
               c.id AS category_id, c.name AS category_name,
               o.discount_type AS bill_discount_type, o.discount_value AS bill_discount_value,
               o.discount_scope AS bill_discount_scope
        FROM order_items oi
        LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        LEFT JOIN categories  c  ON c.id  = COALESCE(mi.category_id, oi.dest_category_id)
        LEFT JOIN orders      o  ON o.id  = oi.order_id
        WHERE o.status='closed' AND oi.voided=0
          AND o.closed_at >= $1::timestamp AND o.closed_at < $2::timestamp
          AND ((o.order_type = 'takeaway' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (p.method = 'cancelled' OR p.method = 'Complimentary' OR COALESCE(p.method,'') LIKE '%(mock)%'))) OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND COALESCE(p.method,'') <> 'cancelled' AND COALESCE(p.method,'') <> 'Complimentary' AND COALESCE(p.method,'') NOT LIKE '%(mock)%'))
      `, [sumFromIso, sumToIso]),
      // SEPOS-VOUCHER-001 — vouchers sold in the date range, split by method
      // SEPOS-FERN-POLISH-001 — mirror the Z's filters (this query predated
      // them): mock-paid sales are demo noise, deposits are NOT voucher sales
      // (they have their own Z block — counting them here made Reports and Z
      // disagree), and a VOIDED voucher (test/mistake, e.g. Fern's first-day
      // trials) must drop off the report once voided.
      pool.query(`SELECT payment_method, COUNT(*)::int AS count, COALESCE(SUM(original_amount), 0) AS total FROM vouchers WHERE created_at::date >= $1::date AND created_at::date <= $2::date AND COALESCE(payment_method,'') != 'mock' AND COALESCE(type,'gift') != 'deposit' AND COALESCE(status,'active') != 'voided' GROUP BY payment_method`, [from, to]).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_used), 0) AS total FROM voucher_redemptions WHERE used_at::date >= $1::date AND used_at::date <= $2::date`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      pool.query(`SELECT key, value FROM settings WHERE key IN ('service_charge_enabled','service_charge_rate','service_charge_percent')`),
      // SEPOS-COMP-001 — bills settled as Complimentary (excluded from every
      // sales figure; reported as their own give-away line)
      pool.query(`SELECT COUNT(DISTINCT o.id)::int AS count, COALESCE(SUM(o.total), 0) AS value FROM orders o JOIN payments p ON p.order_id = o.id AND p.method = 'Complimentary' WHERE o.status='closed' AND o.closed_at >= $1::timestamp AND o.closed_at < $2::timestamp`, [sumFromIso, sumToIso]).catch(() => ({ rows: [{ count: 0, value: 0 }] })),
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
    // SEPOS-DISCOUNT-SCOPE-001 — factors computed here (not just for the
    // food/drink split below) because a scoped discount's £ depends on the
    // order's ITEMS, which only the per-item rows carry. Unscoped orders keep
    // the exact total-based formula they always had.
    const fdFactors = billDiscountFactors(foodDrinkRes.rows);
    const total_discounts = uniqueOrders.reduce((s, r) => {
      if (!r.discount_value) return s;
      if (r.discount_scope === 'food' || r.discount_scope === 'drink') {
        return s + (fdFactors.get(r.id)?.amount || 0);
      }
      return s + (r.discount_type === 'percent' ? (r.total || 0) * (r.discount_value / 100) : Number(r.discount_value));
    }, 0);
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

    // SEPOS-AUDIT-001 — aggregate the per-item rows with the bill-level
    // discount factor (see the query comment above). SEPOS-DISCOUNT-SCOPE-001:
    // the factor is per-ROW now — out-of-scope items keep factor 1.
    let total_food = 0, total_drink = 0;
    // SEPOS-CATREPORT-001 — per-category net using the same discount-aware
    // maths as the food/drink split (client request 13 Aug).
    const catAgg = new Map();
    for (const r of foodDrinkRes.rows) {
      let net = Number(r.quantity || 0) * Number(r.unit_price || 0);
      if (r.discount_type === 'percent') net *= 1 - (Number(r.discount_value || 0) / 100);
      else if (r.discount_type === 'fixed') net = Math.max(0, net - Number(r.discount_value || 0));
      net *= rowBillFactor(fdFactors, r);
      if (Number(r.is_bar) === 1) total_drink += net;
      else                        total_food  += net;
      const catKey = r.category_id != null ? String(r.category_id) : 'other';
      const cat = catAgg.get(catKey) || { name: r.category_name || 'Other', is_bar: Number(r.is_bar) === 1 ? 1 : 0, net: 0, qty: 0 };
      cat.net += net; cat.qty += Number(r.quantity || 0);
      catAgg.set(catKey, cat);
    }
    const by_category = [...catAgg.values()].sort((a, b) => b.net - a.net);

    res.json({
      orders: rows, total_sales, total_paid, total_subtotal, total_service, total_discounts,
      service_charge_rate: scRate, service_charge_enabled: scEnabled,
      total_food, total_drink, by_category,
      comp_bills: { count: Number(compRes.rows[0]?.count || 0), value: Number(compRes.rows[0]?.value || 0) },
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
    // SEPOS-AUDIT-001 — exclude written-off bills (all payments 'cancelled')
    // so Item Sales stops counting items the sales totals exclude.
    // SEPOS-AUDIT-002 F30 — bucket by the RESTAURANT's day (SEPOS-048 helpers),
    // not the UTC calendar day: in BST a 00:30 order landed on the previous day
    // here while /api/reports/daily put it on the right one, so the two reports
    // disagreed after every late service.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
      return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
    }
    const mpTz = await restaurantTz();
    const mpFrom = zonedMidnightUtc(from, mpTz);
    const mpToNext = new Date(Date.parse(`${to}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const mpTo = zonedMidnightUtc(mpToNext, mpTz);
    if (!mpFrom || !mpTo) return res.status(400).json({ error: 'Invalid date range' });
    const result = await pool.query(`SELECT menu_items.name, menu_items.price, SUM(order_items.quantity) as qty_sold, SUM(order_items.quantity * order_items.unit_price) as total_revenue FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN orders ON order_items.order_id = orders.id WHERE orders.status='closed' AND order_items.voided=0 AND orders.closed_at >= $1::timestamp AND orders.closed_at < $2::timestamp AND ((orders.order_type = 'takeaway' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND (p.method = 'cancelled' OR COALESCE(p.method,'') LIKE '%(mock)%'))) OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND COALESCE(p.method,'') <> 'cancelled' AND COALESCE(p.method,'') NOT LIKE '%(mock)%')) GROUP BY menu_items.id, menu_items.name, menu_items.price ORDER BY qty_sold DESC`, [mpFrom.toISOString(), mpTo.toISOString()]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/kitchen/completed', async (req, res) => {
  try {
    const result = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway, order_items.fired_at, order_items.served_at, orders.order_type, orders.customer_name, orders.pickup_time, orders.order_subtype, orders.delivery_address, orders.takeaway_status FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id LEFT JOIN orders ON order_items.order_id = orders.id LEFT JOIN tables ON orders.table_id = tables.id WHERE order_items.status='served' AND order_items.voided=0 AND (categories.is_bar=0 OR categories.is_bar IS NULL) AND order_items.served_at::date = CURRENT_DATE ORDER BY order_items.order_id ASC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/bill-printed', async (req, res) => {
  try {
    await pool.query('UPDATE orders SET bill_printed=1 WHERE id=$1', [req.params.id]);
    // SEPOS-AUDIT-001 — push so the floor-map colour survives the cloud pull.
    await offlineQueue.enqueue('update_order_flags', {
      localOrderId: Number(req.params.id), bill_printed: 1,
    });
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
    const GHOST_GRACE_MS = 3 * 60 * 1000;
    const nowMs = Date.now();
    const result = orders.map(order => {
      const items = itemsByOrder[order.id] || [];
      // SEPOS-GHOST-001 — a phantom order (0 items) past the grace window was
      // abandoned or double-tapped open; drop it so it doesn't ghost-occupy its
      // table. Without this a 0-item open order defaults to 'occupied' below.
      if (items.length === 0) {
        const t = order.created_at ? new Date(order.created_at).getTime() : nowMs;
        if (Number.isFinite(t) && (nowMs - t) >= GHOST_GRACE_MS) return null;
      }
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
    }).filter(Boolean);

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
    const result = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway, order_items.fired_at, order_items.served_at, orders.order_type, orders.customer_name, orders.pickup_time FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id LEFT JOIN orders ON order_items.order_id = orders.id LEFT JOIN tables ON orders.table_id = tables.id WHERE order_items.status='served' AND order_items.voided=0 AND categories.is_bar=1 AND order_items.served_at::date = CURRENT_DATE ORDER BY order_items.order_id ASC`);
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
    await freeTableIfEmpty(oldTableId);   // round 5 — old table may still hold another order
    await pool.query("UPDATE tables SET status='occupied' WHERE id=$1", [new_table_id]);
    // SEPOS-AUDIT-001 — push the move (table ids are shared cloud/local since
    // the tables pull keeps cloud pks); without it the pull snapped the party
    // back to the old table within 5s.
    await offlineQueue.enqueue('move_order', { localOrderId: Number(orderId), new_table_id });
    io.emit('table_moved', { order_id: orderId, old_table_id: oldTableId, new_table_id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/merge', async (req, res) => {
  try {
    const { merge_order_id } = req.body;
    const targetOrderId = req.params.id;
    // SEPOS-QR-PAY-REDO (verify pass, round 5) — a QR order is the customer's
    // prepaid, staff-read-only bill; it must not be merged (into or out of).
    // Moving the tender rows kept the ledger balanced but the Bill screen still
    // re-billed the full merged total with no netting of the prepaid round, so
    // the guest paid it twice. Refusing the merge is consistent with the
    // read-only rule and removes the double-charge at the root.
    const srcTgt = await pool.query(
      "SELECT id, source, payment_status FROM orders WHERE id = ANY($1::int[])", [[Number(merge_order_id), Number(targetOrderId)]]);
    if (srcTgt.rows.some(o => o.source === 'qr' && ['paid', 'mock'].includes(String(o.payment_status || '')))) {   // SEPOS-QR-PAYLATER-001 — only PREPAID QR bills refuse merging
      return res.status(409).json({ error: 'A customer QR order cannot be merged — settle it on its own.', qrReadOnly: true });
    }
    // SEPOS-AUDIT-001 (verify pass) — capture the moving item ids BEFORE the
    // UPDATE: they go into the merge push payload so itemsWithPendingPush
    // protects them from the pull while the push is in flight (without this a
    // single failed push tick let the pull snap the merged items back onto
    // the closed £0 source shell).
    const movedItemsRes = await pool.query('SELECT id FROM order_items WHERE order_id=$1', [merge_order_id]);
    const movedItemIds = movedItemsRes.rows.map(r => Number(r.id));
    await pool.query('UPDATE order_items SET order_id=$1 WHERE order_id=$2', [targetOrderId, merge_order_id]);
    // (QR merges are refused above, so this only ever moves a non-QR order's
    // tenders — usually none on an open bill; harmless.) Move the TENDERS too. The
    // source can now be a prepaid QR order (it carries 'QR Online' payment
    // rows); moving only the items and closing the shell at total=0 stranded
    // that money, so staff took the full merged total again and the guest paid
    // that round twice. Relocate payments and order_items.payment_id with the
    // items so the target bill already shows what was prepaid.
    await pool.query('UPDATE payments SET order_id=$1 WHERE order_id=$2', [targetOrderId, merge_order_id]);
    const mergeRes = await pool.query('SELECT table_id, covers FROM orders WHERE id=$1', [merge_order_id]);
    if (mergeRes.rows[0]) await freeTableIfEmpty(mergeRes.rows[0].table_id);   // round 5
    // SEPOS-AUDIT-001 — the party physically merged: move the source's covers
    // onto the target and zero the shell's, so cover counts stay right on
    // every report (the shell used to keep its covers, inflating the Z's
    // totals while Reports/Bills excluded it — the counts never agreed).
    const srcCovers = Number(mergeRes.rows[0]?.covers) || 0;
    if (srcCovers > 0) {
      await pool.query('UPDATE orders SET covers = COALESCE(covers,0) + $1 WHERE id=$2', [srcCovers, targetOrderId]);
    }
    // Zero the merged (source) order's total — its items moved to the target,
    // so leaving the old total made it a "closed, no payment" phantom that
    // inflated the sales report. total=0 keeps it out of the figures.
    // covers=0 + service_charge=0: it's an artifact, not a sale.
    await pool.query(`UPDATE orders SET status='closed', closed_at=NOW(), total=0, covers=0, service_charge=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [merge_order_id]);
    const totalRes = await pool.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id=$1 AND voided=0`, [targetOrderId]); // SEPOS-047c — keep per-item discounts
    await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, targetOrderId]);
    // SEPOS-AUDIT-001 — replay the merge on the cloud; without it the pull
    // fully un-merged (items snapped back to the source order, which reopened).
    await offlineQueue.enqueue('merge_orders', {
      localOrderId: Number(targetOrderId), mergeLocalOrderId: Number(merge_order_id),
      localItemIds: movedItemIds, // pull-protects the relocated items (verify pass)
    });
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
        await freeTableIfEmpty(order.table_id);   // round 5
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
// SEPOS-AUDIT-001 — cloud-side replay of a till's closed-bill payment edit
// (SEPOS-BILLEDIT-001). Local payment row ids don't exist on the cloud, so the
// till pushes an id-free description and this endpoint matches each edit to a
// cloud payments row by (order, from_method, from_amount). Idempotent: a
// replayed edit whose from-row no longer exists (already applied) is skipped.
app.post('/api/sync/edit-payment', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'SYNC_SECRET not set on this server' });
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });
  try {
    const orderId = parseInt(req.body?.order_id, 10) || 0;
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    const reason = req.body?.reason || null;
    const byName = req.body?.amended_by_name || 'till';
    if (!orderId || edits.length === 0) return res.status(400).json({ error: 'order_id and edits[] required' });
    // Verify pass — idempotency: if this sync_key was already applied (replay
    // after a lost markSynced), skip instead of re-matching — semantic
    // matching alone double-applies when TWO identical (method, amount) rows
    // exist and one was already amended.
    const syncKey = req.body?.sync_key ? String(req.body.sync_key).slice(0, 64) : null;
    if (syncKey) {
      const seen = await pool.query(
        `SELECT 1 FROM payment_amendments WHERE order_id = $1 AND reason LIKE $2 LIMIT 1`,
        [orderId, `%[sync:${syncKey}]%`]
      );
      if (seen.rows[0]) return res.json({ ok: true, applied: 0, skipped: edits.length, alreadyApplied: true });
    }
    const cur = await pool.query(
      `SELECT id, method, amount FROM payments WHERE order_id = $1 AND COALESCE(method,'') != 'cancelled' ORDER BY id ASC`,
      [orderId]
    );
    const rows = [...cur.rows];
    let applied = 0, skipped = 0;
    for (const e of edits) {
      const idx = rows.findIndex(p =>
        String(p.method) === String(e.from_method) &&
        Math.abs(Number(p.amount || 0) - Number(e.from_amount || 0)) < 0.005);
      if (idx === -1) { skipped++; continue; }             // already applied / diverged — idempotent skip
      const row = rows.splice(idx, 1)[0];
      const remove = !!e.remove;
      const newAmt = remove ? 0 : Number(e.to_amount);
      const newMethod = remove ? 'cancelled' : (e.to_method || row.method);
      if (!remove && (!Number.isFinite(newAmt) || newAmt <= 0)) { skipped++; continue; }
      const note = (remove
        ? `Removed payment: £${Number(row.amount).toFixed(2)} ${row.method} (till sync)`
        : `Payment corrected: £${Number(row.amount).toFixed(2)} ${row.method} → £${newAmt.toFixed(2)} ${newMethod} (till sync by ${byName})`)
        + (syncKey ? ` [sync:${syncKey}]` : '');
      await pool.query(
        `INSERT INTO payment_amendments (payment_id, order_id, from_method, to_method, reason, amended_by)
         VALUES ($1,$2,$3,$4,$5,NULL)`,
        [row.id, orderId, row.method, newMethod, [reason, note].filter(Boolean).join(' — ')]
      );
      await pool.query(
        `UPDATE payments SET amount = $1, method = $2, amended_at = CURRENT_TIMESTAMP,
             amend_reason = $3, amended_from = COALESCE(amended_from, $4)
         WHERE id = $5`,
        [newAmt, newMethod, [reason, note].filter(Boolean).join(' — '), row.method, row.id]
      );
      applied++;
    }
    io.emit('payment_amended', { order_id: orderId, by: byName });
    res.json({ ok: true, applied, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-AUDIT-001 (verify pass) — cloud-side replay of a till's method
// amendment. The PIN was validated ON THE TILL at request time; persisting it
// in sync_queue (readable via the unauthenticated queue endpoints) was a
// credential leak, so the replay authenticates with SYNC_SECRET instead and
// carries only the amender's name for the audit row.
app.post('/api/sync/amend-method', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'SYNC_SECRET not set on this server' });
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });
  try {
    const orderId = parseInt(req.body?.order_id, 10) || 0;
    const newMethod = req.body?.new_method;
    const reason = req.body?.reason || null;
    const byName = req.body?.amended_by_name || 'till';
    const allowed = ['Cash', 'Card', 'Other', 'Stripe'];
    if (!orderId || !allowed.includes(newMethod)) return res.status(400).json({ error: 'order_id and valid new_method required' });
    const payRes = await pool.query(
      `SELECT id, method, amount FROM payments WHERE order_id = $1 AND COALESCE(method,'') != 'cancelled' ORDER BY id DESC LIMIT 1`,
      [orderId]
    );
    const payment = payRes.rows[0];
    if (!payment) return res.status(404).json({ error: 'No payment to amend on this bill' });
    if (payment.method === newMethod) return res.json({ ok: true, alreadyAmended: true });
    if (String(payment.method).toLowerCase() === 'voucher') return res.status(400).json({ error: 'Voucher payments cannot be amended' });
    await pool.query(
      `INSERT INTO payment_amendments (payment_id, order_id, from_method, to_method, reason, amended_by)
       VALUES ($1,$2,$3,$4,$5,NULL)`,
      [payment.id, orderId, payment.method, newMethod, [reason, `(till sync by ${byName})`].filter(Boolean).join(' — ')]
    );
    await pool.query(
      `UPDATE payments SET method = $1, amended_at = CURRENT_TIMESTAMP, amend_reason = $2, amended_from = COALESCE(amended_from, $3) WHERE id = $4`,
      [newMethod, [reason, `(till sync by ${byName})`].filter(Boolean).join(' — '), payment.method, payment.id]
    );
    io.emit('payment_amended', { order_id: orderId, by: byName });
    res.json({ ok: true, from_method: payment.method, to_method: newMethod });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-AUDIT-001 (verify pass) — raw voucher_redemptions feed for the
// desktop pull. Vouchers became cloud-authoritative (redeem/sell forward to
// the cloud), so the till's LOCAL voucher tables went empty and the Z's
// voucher figures (incl. the drawer reconciliation) regressed to zero. This
// (with vouchers, which /api/vouchers already serves) mirrors both tables
// cloud→local read-only so reports see them again. Recent window only.
// REG-1 (Nook 2026-07-14) — gated: this was live-leaking redemption rows to
// the anonymous internet. The desktop pull authenticates with x-sync-secret.
app.get('/api/voucher-redemptions', requireStaffAuthOrSyncSecret(), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, voucher_id, bill_id, amount_used, redeemed_by, used_at, restaurant_id
         FROM voucher_redemptions
        WHERE used_at >= (CURRENT_DATE - INTERVAL '120 days')
        ORDER BY id DESC LIMIT 5000`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-AUDIT-001 (verify pass) — replay a voucher SOLD OFFLINE on a till.
// Re-INSERTs with the SAME code the customer already holds; idempotent via
// ON CONFLICT(code) so a replay after a lost markSynced is a no-op.
app.post('/api/sync/sell-voucher', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'SYNC_SECRET not set on this server' });
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const amt = Number(b.original_amount);
    if (!code || !(amt > 0)) return res.status(400).json({ error: 'code and original_amount required' });
    const method = ['cash', 'card'].includes(String(b.payment_method)) ? String(b.payment_method) : 'cash';
    const r = await pool.query(
      `INSERT INTO vouchers
         (code, original_amount, balance, recipient_name, recipient_email,
          sender_name, message, delivery_date, expires_at, payment_method, restaurant_id)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (code) DO NOTHING
       RETURNING id`,
      [code, amt, b.recipient_name || null, b.recipient_email || null,
       b.sender_name || null, b.message || null, b.delivery_date || null,
       b.expires_at || voucherSvc.defaultExpiryDate(), method,
       b.restaurant_id || process.env.RESTAURANT_ID || 'siamepos'],
    );
    res.json({ ok: true, created: r.rows.length > 0, alreadyExists: r.rows.length === 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      try { await freeTableIfEmpty(order.table_id); } catch {}   // round 5
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
    // SEPOS-AUDIT-001 — we only reach this INSERT on a local install when the
    // cloud forward failed (offline). Queue a replay so the shift exists on
    // the cloud once connectivity returns (cloud open handler dedupes via its
    // unique open-session index — a 409 replay counts as success).
    await offlineQueue.enqueue('session_open', {
      staff_id: staff_id || null, float_amount: Number(float_amount) || 0,
    });
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
    // SEPOS-AUDIT-001 — offline close: replay on the cloud when back online so
    // the shift doesn't reopen from the next sessions pull (409 'no open
    // shift' on replay counts as success — someone already closed it there).
    await offlineQueue.enqueue('session_close', {
      closed_by: closed_by || null, z_report_id: z_report_id || null,
    });
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
    const [ordersRes, openRes, voidsRes, voidsByTypeRes, vatRowsRes, foodDrinkRes, vouchersSoldRes, vouchersRedeemedRes, settingsRes, depTakenRes, depRedeemedRes, depForfeitedRes, depHeldRes, compResZ] = await Promise.all([
      // SEPOS-REPREC-001 — exclude cancelled/void bills (payment method='cancelled', £0)
      // from the Z so its Total Sales + order count reconcile with Trading and Bills.
      // A closed order with no payment row (method NULL) is still kept.
      pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway, payments.method, payments.amount as paid_amount FROM orders LEFT JOIN tables ON orders.table_id = tables.id LEFT JOIN payments ON orders.id = payments.order_id WHERE orders.status='closed' AND orders.closed_at >= $1::timestamp AND orders.closed_at <= $2::timestamp AND (payments.method IS NULL OR payments.method != 'cancelled' AND COALESCE(payments.method,'') <> 'Complimentary' AND COALESCE(payments.method,'') NOT LIKE '%(mock)%') ORDER BY orders.closed_at DESC`, [from, to]),
      pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='open'`),
      // SEPOS-AUDIT-001 — window on WHEN the void happened (voided_at, stamped
      // by the void endpoint since this fix), not on orders.created_at: a void
      // during the shift on a table seated BEFORE the shift used to vanish
      // from that shift's Z. Legacy rows (voided_at NULL) fall back to the old
      // created_at behaviour.
      pool.query(`SELECT COUNT(*) as void_count, SUM(order_items.unit_price * order_items.quantity) as void_value FROM order_items LEFT JOIN orders ON order_items.order_id = orders.id WHERE order_items.voided=1 AND ((order_items.voided_at IS NOT NULL AND order_items.voided_at >= $1::timestamp AND order_items.voided_at <= $2::timestamp) OR (order_items.voided_at IS NULL AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp))`, [from, to]),
      // SEPOS-023: breakdown by void_type
      pool.query(`SELECT COALESCE(order_items.void_type, 'Uncategorised') AS void_type, COUNT(*) AS count, COALESCE(SUM(order_items.unit_price * order_items.quantity), 0) AS value FROM order_items LEFT JOIN orders ON order_items.order_id = orders.id WHERE order_items.voided=1 AND ((order_items.voided_at IS NOT NULL AND order_items.voided_at >= $1::timestamp AND order_items.voided_at <= $2::timestamp) OR (order_items.voided_at IS NULL AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp)) GROUP BY order_items.void_type ORDER BY value DESC`, [from, to]),
      // SEPOS-021: rows for VAT breakdown (aggregated in JS)
      // SEPOS-AUDIT-001 — exclude bills whose payments were all written off
      // (method='cancelled' via the Bills editor): their items counted in the
      // VAT/food/drink breakdowns while total_sales excluded them.
      pool.query(`SELECT COALESCE(mi.vat_rate, 20) AS vat_rate, oi.order_id, oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value, COALESCE(c.is_bar, 0) AS is_bar, o.discount_type AS bill_discount_type, o.discount_value AS bill_discount_value, o.discount_scope AS bill_discount_scope FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id LEFT JOIN categories c ON c.id = COALESCE(mi.category_id, oi.dest_category_id) LEFT JOIN orders o ON o.id = oi.order_id WHERE o.status='closed' AND oi.voided=0 AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp AND ((o.order_type = 'takeaway' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (p.method = 'cancelled' OR p.method = 'Complimentary' OR COALESCE(p.method,'') LIKE '%(mock)%'))) OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND COALESCE(p.method,'') <> 'cancelled' AND COALESCE(p.method,'') <> 'Complimentary' AND COALESCE(p.method,'') NOT LIKE '%(mock)%'))`, [from, to]),
      // Korakot 2026-06-02: food vs drink split via categories.is_bar.
      // SEPOS-AUDIT-001 — per-order rows (aggregated in JS with the bill-level
      // discount factor, like VAT): the flat SUM ignored bill discounts, so a
      // 100%-comped bill counted full price in Food/Drink while contributing
      // £0 to total_sales. Same cancelled-bill exclusion as above.
      pool.query(`
        SELECT oi.order_id, oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value,
               COALESCE(c.is_bar, 0) AS is_bar,
               o.discount_type AS bill_discount_type, o.discount_value AS bill_discount_value,
               o.discount_scope AS bill_discount_scope
        FROM order_items oi
        LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        LEFT JOIN categories  c  ON c.id  = COALESCE(mi.category_id, oi.dest_category_id)
        LEFT JOIN orders      o  ON o.id  = oi.order_id
        WHERE o.status='closed' AND oi.voided=0
          AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
          AND ((o.order_type = 'takeaway' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (p.method = 'cancelled' OR p.method = 'Complimentary' OR COALESCE(p.method,'') LIKE '%(mock)%'))) OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND COALESCE(p.method,'') <> 'cancelled' AND COALESCE(p.method,'') <> 'Complimentary' AND COALESCE(p.method,'') NOT LIKE '%(mock)%'))
      `, [from, to]),
      // SEPOS-VOUCHER-001: vouchers sold in the range (Stripe — off till)
      // SEPOS-DEPOSIT-001: GIFT vouchers only (deposits excluded — reported separately below).
      // SEPOS-AUDIT-001 — split by payment_method so till cash/card voucher
      // sales reconcile the drawer (a £50 cash voucher sale used to read
      // 'Over £50' at close and was mislabelled as settled to Stripe).
      pool.query(`SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(original_amount), 0) AS total FROM vouchers WHERE created_at >= $1::timestamp AND created_at <= $2::timestamp AND payment_method != 'mock' AND COALESCE(type,'gift') != 'deposit' AND COALESCE(status,'active') != 'voided' GROUP BY payment_method`, [from, to]).catch(() => ({ rows: [] })),
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
      // SEPOS-COMP-001 — complimentary settlements in this window
      pool.query(`SELECT COUNT(DISTINCT o.id)::int AS count, COALESCE(SUM(o.total), 0) AS value FROM orders o JOIN payments p ON p.order_id = o.id AND p.method = 'Complimentary' WHERE o.status='closed' AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp`, [from, to]).catch(() => ({ rows: [{ count: 0, value: 0 }] })),
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
      gross *= rowBillFactor(vatFactors, row); // distribute the order's bill-level discount (scope-aware)
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
    // SEPOS-AUDIT-001 — exclude merge-shell artifacts from COUNTS: a merge's
    // source order closes with no payment row and £0 (its items moved to the
    // target), so the Z counted an extra order + its covers while Reports and
    // Bills excluded it — the three screens never agreed on merge nights.
    // (Legit £0 bills — close-zero / all-voided — carry a 'zero' payment row
    // and still count everywhere.)
    const isShellArtifact = (o) => o.method == null && Number(o.total || 0) === 0
      && (o.order_type || 'dine_in') !== 'takeaway';
    const uniqueOrders = [...byOrder.values()].filter(o => !isShellArtifact(o));
    const countableRows = orders.filter(o => !isShellArtifact(o));
    const totalSubtotal  = uniqueOrders.reduce((s, o) => s + Number(o.total ?? 0), 0);
    // SEPOS-DISCOUNT-SCOPE-001 — scoped discounts take their £ from the
    // per-item rows (fdFactors); unscoped keep the exact legacy formula.
    const fdFactors = billDiscountFactors(foodDrinkRes.rows);
    const totalDiscounts = uniqueOrders.reduce((s, o) => {
      if (!o.discount_value) return s;
      if (o.discount_scope === 'food' || o.discount_scope === 'drink') {
        return s + (fdFactors.get(o.id)?.amount || 0);
      }
      return s + (o.discount_type === 'percent' ? (o.total || 0) * (o.discount_value / 100) : Number(o.discount_value));
    }, 0);
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
    const totalOrders    = uniqueOrders.length;
    const orderTypeSplit = splitByOrderType(countableRows);
    // SEPOS-AUDIT-001 — food/drink now aggregates per-item rows in JS with the
    // bill-level discount factor (same treatment as VAT), so a comped bill's
    // items scale down exactly like they do in total_sales.
    let totalFood = 0, totalDrink = 0;
    for (const r of foodDrinkRes.rows) {
      let net = Number(r.quantity || 0) * Number(r.unit_price || 0);
      if (r.discount_type === 'percent') net *= 1 - (Number(r.discount_value || 0) / 100);
      else if (r.discount_type === 'fixed') net = Math.max(0, net - Number(r.discount_value || 0));
      net *= rowBillFactor(fdFactors, r);
      if (Number(r.is_bar) === 1) totalDrink += net;
      else                        totalFood  += net;
    }
    // SEPOS-AUDIT-001 — voucher sales split by method (cash/card = through the
    // till drawer; stripe = off-till). Keeps the legacy aggregate shape too.
    const vouchersSoldByMethod = {};
    let vSoldCount = 0, vSoldTotal = 0, vSoldTillCash = 0, vSoldTillCard = 0;
    for (const r of (vouchersSoldRes.rows || [])) {
      const m = String(r.payment_method || 'unknown').toLowerCase();
      vouchersSoldByMethod[m] = { count: Number(r.count || 0), total: Number(r.total || 0) };
      vSoldCount += Number(r.count || 0); vSoldTotal += Number(r.total || 0);
      if (m === 'cash') vSoldTillCash += Number(r.total || 0);
      if (m === 'card') vSoldTillCard += Number(r.total || 0);
    }
    const vouchersSold     = { count: vSoldCount, total: vSoldTotal };
    const vouchersRedeemed = vouchersRedeemedRes.rows[0] || { count: 0, total: 0 };
    res.json({ orders, open_orders: openRes.rows, total_sales: totalSales, total_paid: totalPaid, total_subtotal: totalSubtotal, total_service: totalService, service_charge_rate: scRate, service_charge_enabled: scEnabled, vat_mode: vatMode, total_food: totalFood, total_drink: totalDrink, total_covers: totalCovers, total_orders: totalOrders, total_cash: totalCash, total_card: totalCard, total_other: totalOther, total_discounts: totalDiscounts, void_count: voids?.void_count || 0, void_value: voids?.void_value || 0, voids_by_type: voidsByType, vat_breakdown: vatBreakdown, vat_total: vatTotal, avg_per_cover: totalCovers > 0 ? totalSales / totalCovers : 0, avg_per_order: totalOrders > 0 ? totalSales / totalOrders : 0, vouchers_sold: { count: Number(vouchersSold.count || 0), total: Number(vouchersSold.total || 0), by_method: vouchersSoldByMethod, till_cash: vSoldTillCash, till_card: vSoldTillCard }, vouchers_redeemed: { count: Number(vouchersRedeemed.count || 0), total: Number(vouchersRedeemed.total || 0) }, deposits_enabled: depositsEnabled, deposits_taken: { count: Number(depTaken.count || 0), total: Number(depTaken.total || 0) }, deposits_redeemed: { count: Number(depRedeemed.count || 0), total: Number(depRedeemed.total || 0) }, deposits_forfeited: { count: Number(depForfeited.count || 0), total: Number(depForfeited.total || 0) }, deposits_held: { count: Number(depHeld.count || 0), total: Number(depHeld.total || 0) }, comp_bills: { count: Number(compResZ.rows[0]?.count || 0), value: Number(compResZ.rows[0]?.value || 0) }, session: sessionMeta, from, to, ...orderTypeSplit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/z-report/save', async (req, res) => {
  try {
    const { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, actual_card, card_difference } = req.body;

    // SEPOS-Z-REPLACE — re-running a Z for the SAME period supersedes the old
    // one, so amend-a-bill → run again leaves ONE authoritative Z, not a
    // confusing pair. Soft (superseded_at stamp, hidden from history) — never
    // a hard delete of a financial record, so the audit trail survives.
    // Matching rules (portable: candidates fetched + compared in JS so PG and
    // SQLite date handling can't diverge):
    //   'day'     → same calendar day (an End of Day always covers the whole
    //               trading day, so a second EOD that day IS a re-run)
    //   'session' → same exact shift-open instant (lunch + dinner closes have
    //               different opens → both kept; only a true re-close replaces)
    //   'custom'  → never auto-replaced (ad-hoc ranges, keep everything)
    try {
      if (type === 'day' || type === 'session') {
        const prior = await pool.query(
          `SELECT id, opened_at FROM z_reports WHERE type = $1 AND superseded_at IS NULL`,
          [type],
        );
        const dayOf = (v) => {
          const d = new Date(v);
          return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
        };
        const ids = prior.rows
          .filter((r) => type === 'day'
            ? dayOf(r.opened_at) === dayOf(from)
            : new Date(r.opened_at).getTime() === new Date(from).getTime())
          .map((r) => r.id);
        for (const id of ids) {
          await pool.query(`UPDATE z_reports SET superseded_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
        }
        if (ids.length) console.log(`[z-replace] superseded ${type} Z id(s) ${ids.join(',')} — re-run for the same period`);
      }
    } catch (e) {
      // Never block the save itself — worst case the old row stays visible.
      console.warn('[z-replace] supersede check failed:', e.message);
    }

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
    // SEPOS-Z-REPLACE — superseded rows (replaced by a re-run) stay in the DB
    // for audit but are hidden from the operator's history.
    const result = await pool.query('SELECT * FROM z_reports WHERE superseded_at IS NULL ORDER BY closed_at DESC LIMIT 30');
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
    // NOTE (simulation, 2026-08-07): the '(mock)' exclusion added for F19
    // belongs on REVENUE queries only. Bills is the LIST OF BILLS — a demo or
    // QR-mock bill is still a real order staff need to find and reprint, it
    // just isn't money. Excluding it here made every QR order on a demo tenant
    // vanish from Admin -> Bills, which is exactly the symptom Korakot
    // reported tonight (from a different cause).
    const _localBills = require('./services/archiveService').isLocalInstall();
    let query = `SELECT orders.id, ${_localBills ? 'orders.cloud_id,' : ''} orders.total, orders.covers, orders.closed_at, orders.discount_type, orders.discount_value, orders.discount_reason, orders.order_type, orders.no_service_charge, orders.service_charge, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway, payments.method, payments.amount as paid_amount, payments.id AS payment_id FROM orders LEFT JOIN tables ON orders.table_id = tables.id LEFT JOIN payments ON orders.id = payments.order_id WHERE orders.status='closed' AND orders.total > 0 AND payments.method IS NOT NULL AND payments.method != 'cancelled'`;
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
              table_label: r.table_label,   // F25 — the SELECT had it; the aggregation dropped it
              // Verify pass — staff search by the number on the CUSTOMER's
              // receipt = the cloud order id. On a Pro till that's r.cloud_id
              // (SQLite-only column); on a cloud tenant the order's own id IS
              // that number. Referencing r.cloud_id in SQL on PG 500'd the
              // whole page (round 4, my own regression).
              cloud_id: _localBills ? r.cloud_id : r.id,
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
    // SEPOS-AUDIT-001 — replay the amendment on the CLOUD (no-op on cloud
    // installs). Without this the exact remediation workflow used for the
    // Thann Thai £78 double-charge fixed only the till's copy of the books —
    // the owner's cloud/ops reports kept the wrong method forever. The public
    // amend-method endpoint carries no payment ids (it flips the latest
    // non-cancelled row), so it replays cleanly with the same PIN.
    // (verify pass: NO pin in the payload — sync_queue is readable via the
    // unauthenticated queue endpoints; the replay authenticates with
    // SYNC_SECRET via POST /api/sync/amend-method instead.)
    await offlineQueue.enqueue('amend_method', {
      localOrderId: orderId, new_method, reason: reason || null, amended_by_name: staff.name,
    });
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
    const semanticEdits = []; // SEPOS-AUDIT-001 — id-free description for the cloud replay
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
      semanticEdits.push({
        from_method: oldMethod, from_amount: oldAmt,
        to_method: newMethod, to_amount: newAmt, remove,
      });
    }

    if (changed === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No changes to apply' }); }
    await client.query('COMMIT');
    // SEPOS-AUDIT-001 — replay on the cloud by (method, amount) matching:
    // local payment row ids don't exist on the cloud, so the replay endpoint
    // (POST /api/sync/edit-payment, SYNC_SECRET-gated) matches semantically.
    await offlineQueue.enqueue('edit_payment', {
      localOrderId: orderId, edits: semanticEdits,
      reason: reason || null, amended_by_name: staff.name,
      // Verify pass — idempotency key: the cloud replay records it in the
      // amendment audit and skips a re-delivery, so a replay after a lost
      // markSynced can't double-apply when the bill holds two identical
      // (method, amount) rows.
      sync_key: require('crypto').randomUUID(),
    });
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
    // SEPOS-AUDIT-001 — mirror the resend on the cloud (no-op on cloud
    // installs); without it the pull flipped the items back off 'cooking' on
    // the KDS within 5s. Item ids are translated to cloud ids at push time.
    await offlineQueue.enqueue('resend_items', {
      localOrderId: Number(req.params.id), localItemIds: item_ids, reason: reason || null,
    });
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [req.params.id]);
    const itemsRes = await pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.id = ANY($1::int[])`, [item_ids]);
    io.emit('course_fired', { order: orderRes.rows[0], course: 0, items: itemsRes.rows });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/order-items/:id/discount', async (req, res) => {
  try {
    const oiRes = await pool.query('SELECT order_id FROM order_items WHERE id = $1', [req.params.id]);
    if (!oiRes.rows[0]) return res.status(404).json({ error: 'Item not found' });
    if (await refuseQrMutation(oiRes.rows[0].order_id, res)) return;   // round 6 — QR read-only
    const { discount_type, discount_value } = req.body;
    await pool.query('UPDATE order_items SET discount_type=$1, discount_value=$2 WHERE id=$3', [discount_type, discount_value, req.params.id]);
    // SEPOS-AUDIT-001 — push the per-item discount so the pull can't revert it.
    await offlineQueue.enqueue('apply_item_discount', {
      localItemId: Number(req.params.id), discount_type, discount_value,
    });
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

// ─── SEPOS-SALESCHAT-001 — AI sales concierge for the marketing site ───
// Public: /api/saleschat/message + /poll (CORS-open, rate-limited). Admin
// (Control Room, x-saleschat-secret gated): list / thread / reply / handoff.
// handoff=TRUE silences the AI so a human can take over the thread.
const SALESCHAT_SECRET = process.env.SALESCHAT_SECRET || '';
const SALESCHAT_SYSTEM = `You are Tara, the friendly assistant for SiamEPOS — a UK restaurant & spa management system built for Thai businesses. You chat with prospective customers on the SiamEPOS marketing website.

WHO YOU ARE
- Introduce yourself as Tara, the SiamEPOS assistant. Warm, concise, helpful — not salesy.
- Tara is female. Reply in the visitor's language. In Thai, always use feminine politeness — end sentences with ค่ะ/คะ and refer to yourself as หนู or by your name Tara. Do NOT use the stiff/formal ดิฉัน, and never use the male ครับ/ผม.
- Be honest: if asked whether you're a person or a bot, say you're SiamEPOS's digital assistant and can connect them with the team. Never pose as a real human staff member.

WHAT SIAMEPOS IS (answer only from this — never invent features or prices)
- All-in-one till (POS) for Thai restaurants & spas in the UK: table plan + kitchen display (KDS), online reservations, online takeaway ordering (0% commission), spa appointments, customer CRM + email campaigns, reports, staff clock-in, inventory, and you can use any tablet or phone as a terminal.
- Runs in a browser AND as a desktop app (Mac & Windows), works offline.
- Add-ons: a client Website (£5/mo), a Social Media service (£39/mo, Facebook + Instagram), SiamPay card payments (1.5% + 30p, no monthly fee), and an AI booking concierge.

PRICING (quote only these; if unsure of a number, say you'll have the team confirm — never guess)
- SiamEPOS: £89/month. Founder's Rate £59/month for early customers. No long tie-in; free onboarding.
- Website £5/mo · Social £39/mo · SiamPay 1.5% + 30p.

HOW TO HELP
- Answer questions about features, pricing, setup and the fit for a Thai UK business.
- Nudge gently toward a demo: point them to "Book a demo" on this site, or offer to take their name + phone so the team calls them.
- For a serious buyer, or anything you can't answer, offer to connect them with the team.
- Keep replies short.`;

function anthropicChat(system, messages) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system, messages });
    const https = require('https');
    const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } },
      (rs) => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => {
        try { const j = JSON.parse(d); resolve((j.content || []).map(b => b.text || '').join('').trim() || null); }
        catch { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.write(body); r.end();
  });
}
const _salesHits = new Map();
function _salesAllow(ip) { const now = Date.now();
  const a = (_salesHits.get(ip) || []).filter(t => now - t < 5 * 60 * 1000);
  if (a.length >= 30) { _salesHits.set(ip, a); return false; }
  a.push(now); _salesHits.set(ip, a); if (_salesHits.size > 5000) _salesHits.clear(); return true; }
function salesAdminAuth(req, res, next) {
  if (!SALESCHAT_SECRET || req.headers['x-saleschat-secret'] !== SALESCHAT_SECRET)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
const _salesMsgs = (m) => (typeof m === 'string' ? JSON.parse(m) : m) || [];

app.post('/api/saleschat/message', widgetCors, async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    if (!_salesAllow(ip)) return res.status(429).json({ reply: 'One moment — please try again shortly.' });
    const { session_id, message } = req.body || {};
    if (typeof session_id !== 'string' || !/^[a-z0-9-]{8,80}$/i.test(session_id)) return res.status(400).json({ error: 'bad session' });
    const text = String(message || '').trim();
    if (!text || text.length > 2000) return res.status(400).json({ error: 'bad message' });
    const cur = (await pool.query('SELECT messages, handoff FROM sales_chats WHERE session_id=$1', [session_id])).rows[0];
    const msgs = cur ? _salesMsgs(cur.messages) : [];
    msgs.push({ role: 'user', content: text, ts: new Date().toISOString() });
    let reply = null;
    if (cur && cur.handoff) {
      // a human is handling this thread — AI stays quiet; the widget poll delivers the human's reply
    } else if (!process.env.ANTHROPIC_API_KEY) {
      reply = 'Thanks! Our team will reply shortly — you can also book a demo on this site. 🙏';
      msgs.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
    } else {
      const aiMsgs = msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      reply = (await anthropicChat(SALESCHAT_SYSTEM, aiMsgs)) || 'Sorry — I had a hiccup. Please try again, or book a demo on this site.';
      msgs.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
    }
    await pool.query(`INSERT INTO sales_chats (session_id, messages) VALUES ($1,$2)
      ON CONFLICT (session_id) DO UPDATE SET messages=$2, updated_at=NOW()`, [session_id, JSON.stringify(msgs)]);
    leadAlert.scan(session_id, 'website chat', text); // SEPOS-LEAD-ALERT-001 — fire-and-forget
    res.json({ reply, handoff: !!(cur && cur.handoff) });
  } catch (e) { console.error('[saleschat] message', e.message); res.status(500).json({ reply: 'Sorry — please try again in a moment.' }); }
});

app.get('/api/saleschat/poll', widgetCors, async (req, res) => {
  try {
    const sid = String(req.query.session_id || ''); const after = parseInt(req.query.after || '0', 10) || 0;
    const cur = (await pool.query('SELECT messages FROM sales_chats WHERE session_id=$1', [sid])).rows[0];
    if (!cur) return res.json({ total: 0, messages: [] });
    const ops = _salesMsgs(cur.messages).filter(m => m.role === 'assistant' && m.operator).map(m => m.content);
    res.json({ total: ops.length, messages: after < ops.length ? ops.slice(after) : [] });
  } catch (e) { res.json({ total: 0, messages: [] }); }
});

app.get('/api/saleschat/admin/conversations', salesAdminAuth, async (req, res) => {
  const rows = (await pool.query(`SELECT session_id, name, messages, handoff, updated_at FROM sales_chats ORDER BY updated_at DESC LIMIT 100`)).rows;
  res.json(rows.map(r => { const m = _salesMsgs(r.messages); const last = m[m.length - 1] || {};
    return { session_id: r.session_id, name: r.name, handoff: !!r.handoff, updated_at: r.updated_at,
             count: m.length, last: String(last.content || '').slice(0, 90), last_role: last.role, last_operator: !!last.operator }; }));
});
app.get('/api/saleschat/admin/conversations/:sid', salesAdminAuth, async (req, res) => {
  const r = (await pool.query('SELECT session_id,name,messages,handoff FROM sales_chats WHERE session_id=$1', [req.params.sid])).rows[0];
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ session_id: r.session_id, name: r.name, handoff: !!r.handoff, messages: _salesMsgs(r.messages) });
});
app.post('/api/saleschat/admin/conversations/:sid/reply', salesAdminAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 2000) return res.status(400).json({ error: 'text required' });
  const r = (await pool.query('SELECT messages FROM sales_chats WHERE session_id=$1', [req.params.sid])).rows[0];
  if (!r) return res.status(404).json({ error: 'not found' });
  const msgs = _salesMsgs(r.messages);
  msgs.push({ role: 'assistant', content: text, operator: true, ts: new Date().toISOString() });
  await pool.query('UPDATE sales_chats SET messages=$2, handoff=TRUE, updated_at=NOW() WHERE session_id=$1', [req.params.sid, JSON.stringify(msgs)]);
  // SEPOS-SALESCHAT-002 — web visitors poll for replies; Messenger users don't.
  // A takeover reply on an fb- thread must be pushed out through the Graph API.
  if (/^fb-\d+$/.test(req.params.sid)) {
    messengerSales.sendText(req.params.sid.slice(3), text)
      .catch(e => console.error('[saleschat] messenger push', e.message));
  }
  res.json({ ok: true, handoff: true });
});

// ─── SEPOS-SALESCHAT-002 — Facebook Messenger doorway for Tara ───
// DMs to the SiamEPOS page flow into the SAME sales_chats store as the
// website chat: same persona, same Control Room list, same human takeover.
// Inert unless the MESSENGER_* env vars are set (main cloud only).
const messengerSales = require('./services/messengerSales');
const leadAlert = require('./services/leadAlert'); // SEPOS-LEAD-ALERT-001
const MESSENGER_ADDENDUM = `
CHANNEL NOTE — you are replying in Facebook Messenger on the SiamEPOS page:
- Keep replies SHORT (1-3 sentences, max ~2 short paragraphs). No markdown, no headers, no bullet walls — plain chat text.
- First reply to a new person: greet briefly, thank them for messaging the page, then answer.
- If they want a demo or a call, ask for their restaurant/spa name and a phone number or email, and say the team (กต) will get back to them the same day.`;

app.get('/api/messenger/webhook', (req, res) => {
  const challenge = messengerSales.verifyWebhook(req.query || {});
  if (challenge != null) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/api/messenger/webhook', async (req, res) => {
  const raw = req.body; // Buffer (raw mount above)
  if (!messengerSales.verifySignature(raw, req.headers['x-hub-signature-256'])) return res.sendStatus(403);
  res.sendStatus(200); // ack fast — Meta retries on slow responses
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
  if (payload.object !== 'page') return;
  for (const m of messengerSales.extractMessages(payload)) {
    const sid = `fb-${m.senderId}`;
    try {
      const cur = (await pool.query('SELECT messages, handoff FROM sales_chats WHERE session_id=$1', [sid])).rows[0];
      const msgs = cur ? _salesMsgs(cur.messages) : [];
      msgs.push({ role: 'user', content: m.text, ts: new Date().toISOString() });
      let reply = null;
      if (cur && cur.handoff) {
        // human owns this thread — store the message; the operator replies from
        // the Control Room (which pushes back through Messenger above)
      } else if (!process.env.ANTHROPIC_API_KEY) {
        reply = 'Thanks for messaging SiamEPOS! Our team will reply shortly. 🙏';
        msgs.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
      } else {
        const aiMsgs = msgs.map(x => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }));
        reply = (await anthropicChat(SALESCHAT_SYSTEM + MESSENGER_ADDENDUM, aiMsgs))
          || 'Sorry — I had a hiccup. Please try again, or visit siamepos.co.uk. 🙏';
        msgs.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
      }
      await pool.query(`INSERT INTO sales_chats (session_id, name, messages) VALUES ($1,$2,$3)
        ON CONFLICT (session_id) DO UPDATE SET messages=$3, updated_at=NOW()`,
        [sid, 'Facebook Messenger', JSON.stringify(msgs)]);
      leadAlert.scan(sid, 'Facebook Messenger', m.text); // SEPOS-LEAD-ALERT-001
      if (reply) await messengerSales.sendText(m.senderId, reply);
    } catch (e) { console.error('[messenger-sales] handle', e.message); }
  }
});
app.post('/api/saleschat/admin/conversations/:sid/handoff', salesAdminAuth, async (req, res) => {
  const on = !!req.body?.handoff;
  await pool.query('UPDATE sales_chats SET handoff=$2, updated_at=NOW() WHERE session_id=$1', [req.params.sid, on]);
  res.json({ ok: true, handoff: on });
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

// SEPOS-048 (cont.) — restaurant-local calendar date (YYYY-MM-DD) and
// wall-clock (HH:MM). Same rule as minutesInZone: NEVER derive a
// customer-facing date/time from the Node process's clock directly —
// Railway runs UTC, so walk-in reservations were stamped 1h early all
// summer and "today" flipped at 1am local.
function dateInZone(date, timeZone) {
  try {
    // en-CA gives ISO-style YYYY-MM-DD directly.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch { return date.toISOString().slice(0, 10); }
}
function hhmmInZone(date, timeZone) {
  const mins = minutesInZone(date, timeZone) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Tenant timezone from settings (each Railway is per-tenant). Cached 60s so
// hot report/walk-in paths don't add a query per hit.
let _tzCache = { value: null, at: 0 };
async function restaurantTz() {
  if (_tzCache.value && Date.now() - _tzCache.at < 60000) return _tzCache.value;
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'timezone'`);
    _tzCache = { value: r.rows[0]?.value || 'Europe/London', at: Date.now() };
  } catch { _tzCache = { value: 'Europe/London', at: Date.now() }; }
  return _tzCache.value;
}

// UTC instant of local midnight for a YYYY-MM-DD in the given zone.
// Iterative: start from UTC midnight, measure what local wall-clock that
// instant shows, and correct by the difference (converges in ≤2 steps,
// DST transitions included). Lets day-windowed reports bound on the
// RESTAURANT's midnight instead of bucketing rows by UTC date.
function zonedMidnightUtc(ymd, timeZone) {
  const tz = timeZone || 'Europe/London';
  let t = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  try {
    for (let i = 0; i < 3; i++) {
      const localYmd = dateInZone(new Date(t), tz);
      const localMins = minutesInZone(new Date(t), tz) % 1440;
      const have = Date.parse(`${localYmd}T00:00:00Z`) + localMins * 60000;
      const want = Date.parse(`${ymd}T00:00:00Z`);
      if (have === want) break;
      t -= (have - want);
    }
  } catch { /* fall through with the UTC-midnight guess */ }
  return new Date(t);
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

    // SEPOS-051 — weekly closed days
    let closedDays = [];
    try { closedDays = JSON.parse(s.closed_days || '[]'); } catch {}
    const DAY_KEYS  = ['sun','mon','tue','wed','thu','fri','sat'];
    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dow = requestedDate.getDay();
    if (closedDays.includes(DAY_KEYS[dow])) {
      return res.json({ date, covers: coversNum, restaurant_id, slots: [], closed: true,
        message: `We are closed on ${DAY_NAMES[dow]}s — please choose another day.` });
    }

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
              timezone, closed_days
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
              timezone, closed_days
       FROM restaurant_settings WHERE restaurant_id = $1`,
      [req.params.restaurantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
    const s = result.rows[0];
    if (!s.is_active) return res.status(403).json({ error: 'Online booking is currently disabled' });
    try { s.closed_days = JSON.parse(s.closed_days || '[]'); } catch { s.closed_days = []; }
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
    const { customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, notes, source = 'widget', table_id = null, status: statusInput, marketing_consent = 0 } = req.body;
    // SEPOS-WORDING-001 (Korakot, 28 Aug) — an online booking already emailed
    // the customer a CONFIRMATION, so the till showing it as "pending"
    // contradicted what the customer was told. Online arrivals land
    // 'confirmed'; a booking that names its status (the staff form) is
    // honoured unchanged.
    const status = statusInput || ((source === 'widget' || source === 'online') ? 'confirmed' : 'pending');
    const restaurant_id = req.body.restaurant_id || process.env.RESTAURANT_ID || 'siamepos';
    if (!customer_name?.trim()) return res.status(400).json({ error: 'Guest name is required' });
    if (!customer_phone?.trim()) return res.status(400).json({ error: 'Phone number is required' });
    if (!reservation_date) return res.status(400).json({ error: 'Date is required' });
    if (!reservation_time) return res.status(400).json({ error: 'Time is required' });
    // BUG-004 — reject bookings for a date already in the past.
    // reservation_date arrives as 'YYYY-MM-DD'; lexical compare against
    // today works for that format. Same-day bookings are allowed.
    // SEPOS-048 — "today" in the restaurant's timezone, not UTC: after 11pm
    // BST the UTC date was still yesterday, so a booking for "today" made
    // just after midnight was wrongly rejected as in-the-past (and vice versa).
    if (String(reservation_date).slice(0, 10) < dateInZone(new Date(), await restaurantTz())) {
      return res.status(400).json({ error: 'Reservation date cannot be in the past' });
    }
    const coversNum = parseInt(covers, 10);
    if (!coversNum || coversNum < 1) return res.status(400).json({ error: 'Covers must be at least 1' });
    const slotCheck = await pool.query(`SELECT COALESCE(SUM(covers), 0) AS booked FROM reservations WHERE reservation_date = $1 AND TO_CHAR(reservation_time, 'HH24:MI') = $2 AND restaurant_id = $3 AND status NOT IN ('cancelled','no-show')`, [reservation_date, reservation_time.slice(0, 5), restaurant_id]);
    const settingsRes = await pool.query('SELECT max_covers_per_slot, max_party_size, restaurant_phone, closed_days FROM restaurant_settings WHERE restaurant_id = $1', [restaurant_id]);
    // SEPOS-051 — refuse bookings on weekly closed days (authoritative; widgets also hide them)
    try {
      const cd = JSON.parse(settingsRes.rows[0]?.closed_days || '[]');
      const dowB = new Date(String(reservation_date) + 'T12:00:00').getDay();
      if (cd.includes(['sun','mon','tue','wed','thu','fri','sat'][dowB])) {
        return res.status(400).json({ error: 'The restaurant is closed on that day — please choose another date.' });
      }
    } catch {}
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

    // SEPOS-WORDING-001 (Korakot, 28 Aug) — this line used to FORCE widget
    // bookings to 'pending', contradicting the confirmation email the guest
    // had already been sent. `status` above resolves widget/online → 'confirmed',
    // explicit staff-form values unchanged, anything else → 'pending'.
    const insertStatus = status;
    const result = await pool.query(
      `INSERT INTO reservations (restaurant_id, table_id, table_ids, customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, status, notes, source, marketing_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [restaurant_id, assignTableId, assignTableIds, customer_name.trim(), customer_phone.trim(), customer_email?.trim() || null, coversNum, reservation_date, reservation_time, insertStatus, notes?.trim() || null, source, marketing_consent ? 1 : 0]
    );
    const reservation = result.rows[0];
    // SEPOS-BIRTHDAY-001 — the widget lets guests add day+month ('MM-DD', no
    // year). Best-effort upsert into customer_profiles with the same key
    // rules as the CRM view; a failure here never fails the booking.
    const bday = String(req.body.customer_birthday || '').trim();
    const bdayM = bday.match(/^(\d{2})-(\d{2})$/);
    if (bdayM && Number(bdayM[1]) >= 1 && Number(bdayM[1]) <= 12 && Number(bdayM[2]) >= 1 && Number(bdayM[2]) <= 31) {
      const bKey = customer_email?.trim() ? customer_email.trim().toLowerCase() : 'p:' + customer_phone.trim();
      pool.query(
        `INSERT INTO customer_profiles (contact_key, birthday, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (contact_key) DO UPDATE SET birthday = $2, updated_at = CURRENT_TIMESTAMP`,
        [bKey, bday]
      ).catch(e => console.warn('[birthday] profile upsert skipped:', e.message));
    }
    io.emit('new_reservation', { ...reservation, reservation_date: String(reservation.reservation_date).split('T')[0], reservation_time: String(reservation.reservation_time).slice(0, 5) });
    if (customer_email) sendBookingConfirmation(reservation).catch(err => console.error('❌ Email error:', err.message));
    // SEPOS-OWNER-ALERT-001 — backup email to the restaurant (fire-and-forget)
    sendRestaurantAlert(
      `New booking · ${String(reservation.reservation_date).split('T')[0]} ${String(reservation.reservation_time).slice(0, 5)} · ${reservation.covers} guests`,
      `<p><b>New booking</b></p>
       <p>${String(reservation.customer_name || '').replace(/[<>]/g,'')} · ${String(reservation.customer_phone || '').replace(/[<>]/g,'')}</p>
       <p style="font-size:18px;"><b>${String(reservation.reservation_date).split('T')[0]} at ${String(reservation.reservation_time).slice(0, 5)}</b> · ${reservation.covers} guests</p>
       ${reservation.notes ? `<p>Notes: ${String(reservation.notes).replace(/[<>]/g,'')}</p>` : ''}`
    ).catch(() => {});
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
        // SEPOS-AUDIT-001 — through the shared mutex + dedupe (see helper).
        const { order: o } = await openDineInOrderDeduped({
          tableId: reservation.table_id, covers: reservation.covers || 1, staffId: staff_id,
        });
        order = o;
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

    // SEPOS-048 — stamp the walk-in with the RESTAURANT's date + wall-clock,
    // not the container's (Railway = UTC → walk-ins were logged 1h early in
    // BST, and just before 1am they landed on yesterday's date).
    const now = new Date();
    const walkinTz = await restaurantTz();
    const today = dateInZone(now, walkinTz);
    const hhmm  = hhmmInZone(now, walkinTz);

    const resvIns = await pool.query(
      `INSERT INTO reservations
         (restaurant_id, table_id, customer_name, customer_phone, customer_email,
          covers, reservation_date, reservation_time, status, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seated',$9,'walk_in') RETURNING *`,
      [restaurant_id, table_id, customer_name.trim() || 'Walk-in',
       customer_phone, customer_email, coversNum, today, hhmm, notes]
    );
    const reservation = resvIns.rows[0];

    // SEPOS-AUDIT-001 — through the shared mutex + dedupe: a double-tapped
    // "Seat walk-in" on two devices used to spawn twin open orders (ghosts).
    const { order } = await openDineInOrderDeduped({
      tableId: table_id, covers: coversNum, staffId: staff_id,
    });

    await pool.query("UPDATE tables SET status='occupied' WHERE id=$1", [table_id]);

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
      // SEPOS-051 — weekly closed days, array of 'mon'..'sun'
      closed_days,
    } = req.body;
    const VALID_DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
    const closedDaysJson = Array.isArray(closed_days)
      ? JSON.stringify(closed_days.filter(d => VALID_DAYS.includes(String(d).toLowerCase())))
      : null;
    await pool.query(
      `INSERT INTO restaurant_settings
         (restaurant_id, restaurant_name, brand_colour, opening_time, last_booking_time,
          service_type, lunch_service_start, lunch_service_end,
          dinner_service_start, dinner_service_end,
          slot_interval_mins, max_covers_per_slot, max_party_size, restaurant_phone,
          booking_lead_hours, booking_advance_days, is_active,
          takeaway_busy_threshold, takeaway_very_busy_threshold,
          takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy, timezone, closed_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
         timezone                     = EXCLUDED.timezone,
         closed_days                  = EXCLUDED.closed_days`,
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
       timezone || 'Europe/London', closedDaysJson]
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

// SEPOS-AI-HELP-001 — forward each answered Q&A to the ops back-office so
// Korakot can see, across ALL restaurants, what clients ask. Fire-and-forget:
// never blocks or fails the reply, and ops being down is a no-op. Only the
// CLOUD forwards (it holds the SYNC_SECRET ops matches to a client row);
// desktop/Sunmi relay to their cloud, which does the forward. The ops domain
// ops-api.siamepos.co.uk does NOT resolve — the Railway URL is the real one
// (override with OPS_API_URL env if it ever changes).
const OPS_API_URL = process.env.OPS_API_URL || 'https://restaurant-epos-back-office-production.up.railway.app';
function forwardAiHelpToOps(entry) {
  if (!process.env.SYNC_SECRET || !OPS_API_URL) return;
  fetch(OPS_API_URL.replace(/\/+$/, '') + '/api/ai-help', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
    body: JSON.stringify(entry),
  }).catch(() => { /* best-effort — ops outages must never touch the client */ });
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
    const INVOICE_PROMPT = `You are reading a supplier invoice or delivery note for a restaurant.\nExtract all information and return ONLY a valid JSON object — no other text, no markdown, no explanation.\n\nRequired JSON structure:\n{\n  "supplier_name": "string",\n  "invoice_date": "YYYY-MM-DD",\n  "invoice_number": "string",\n  "total_amount": number,\n  "line_items": [\n    { "name": "string", "quantity": number, "unit": "string", "unit_price": number, "line_total": number, "pack_size": number, "pack_unit": "string" }\n  ]\n}\n\nRules: If a value is missing use null for strings and 0 for numbers. Convert prices to GBP. pack_size/pack_unit describe what ONE invoiced unit contains when stated — a case/box of "6 x 1L" means ONE case contains 6 L, so pack_size 6, pack_unit "L" — e.g. "2 cases Soy Sauce 6 x 1L @ \u00a328.50/case" \u2192 quantity 2, unit "case", unit_price 28.50, pack_size 6, pack_unit "L"; "Mirin 500ml bottle x 6" \u2192 quantity 6, unit "bottle", pack_size 500, pack_unit "ml"; "Chicken 2.5kg bag" \u2192 quantity N, unit "bag", pack_size 2.5, pack_unit "kg". Use 0/null when the pack content is not stated. Return ONLY the JSON object.`;
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

// SEPOS-AI-HELP-001 — in-app "Ask AI" help assistant. Any logged-in staff
// (roles=null) OR a desktop/Sunmi relay via SYNC_SECRET. Desktop/Sunmi hold
// no ANTHROPIC_API_KEY, so they relay to the cloud exactly like the scanners.
app.post('/api/ai/help', requireStaffAuthOrSyncSecret(), async (req, res) => {
  try {
    const { messages, platform } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages[] is required' });
    }
    // Sanitise: only {role, content} strings, last 12 turns, length-capped.
    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (clean.length === 0 || clean[clean.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'the last message must be from the user' });
    }
    // No key here (desktop/Sunmi till) → relay to cloud, same as the scanners.
    if (!process.env.ANTHROPIC_API_KEY) {
      const relayed = await relayAiToCloud('/api/ai/help', { messages: clean, platform });
      if (relayed) return res.status(relayed.status).json(relayed.json);
      return res.json({ reply: "I can't reach the help service right now — check your internet connection, or contact SiamEPOS support (message Korakot on LINE, or email info@siamepos.co.uk)." });
    }
    // Ground the answer in this restaurant's live settings (KV settings table).
    const ctx = { platform: platform || null, settings: {}, restaurant_name: process.env.RESTAURANT_NAME || null };
    try {
      const sres = await pool.query(
        `SELECT key, value FROM settings WHERE key IN
           ('service_charge_enabled','service_charge_rate','vat_mode','deposits_enabled')`);
      sres.rows.forEach(r => { ctx.settings[r.key] = r.value; });
    } catch { /* grounding is best-effort — answer generically if it fails */ }
    const aiHelp = require('./services/aiHelpService');
    const out = await aiHelp.askHelp(clean, ctx);
    if (!out.reply) {
      return res.json({ reply: "Sorry, I hit a technical problem just then. Try again in a moment — or if it keeps happening, contact SiamEPOS support (Korakot on LINE / info@siamepos.co.uk)." });
    }
    // Fire-and-forget: log this Q&A to ops (what clients ask = gold).
    forwardAiHelpToOps({
      question: clean[clean.length - 1].content,
      reply: out.reply,
      platform: platform || null,
      staff_role: (req.staffAuth && req.staffAuth.role) || null,
      escalated: /contact SiamEPOS support|info@siamepos\.co\.uk|Korakot on LINE/i.test(out.reply),
      restaurant_name: process.env.RESTAURANT_NAME || null,
    });
    res.json({ reply: out.reply });
  } catch (err) {
    console.error('POST /api/ai/help error:', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-CONCIERGE-DEMO — public customer-chat concierge (WhatsApp-bot brain).
// Grounded per-profile in conciergeService; CORS locked to the profile's own
// site origins; small per-IP rate limit since this is unauthenticated.
const _conciergeHits = new Map(); // ip -> [timestamps]
function _conciergeAllow(ip) {
  const now = Date.now();
  const arr = (_conciergeHits.get(ip) || []).filter(t => now - t < 5 * 60 * 1000);
  if (arr.length >= 25) { _conciergeHits.set(ip, arr); return false; }
  arr.push(now); _conciergeHits.set(ip, arr);
  if (_conciergeHits.size > 5000) _conciergeHits.clear(); // memory guard
  return true;
}
function _conciergeCors(req, res) {
  const concierge = require('./services/conciergeService');
  const profile = concierge.getProfile(req.params.profile);
  const origin = req.headers.origin;
  if (profile && origin && profile.origin_whitelist.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Vary', 'Origin');
  }
  return profile;
}
app.options('/api/concierge/:profile', (req, res) => { _conciergeCors(req, res); res.sendStatus(204); });
app.post('/api/concierge/:profile', async (req, res) => {
  try {
    const concierge = require('./services/conciergeService');
    const profile = _conciergeCors(req, res);
    if (!profile) return res.status(404).json({ error: 'unknown profile' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    if (!_conciergeAllow(ip)) return res.status(429).json({ error: 'slow down a little — try again in a few minutes' });
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ reply: profile.greeting });
    }
    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 1000) }));
    if (clean.length === 0 || clean[clean.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'the last message must be from the user' });
    }
    const diary = profile.treatments ? await _conciergeDiary(req.params.profile, profile) : '';
    const out = await concierge.askConcierge(req.params.profile, clean, diary);
    const reply = out.reply || profile.fallback || 'Sorry — please try again in a moment.';
    // Owner-inbox transcript (fire-and-forget; never blocks the reply).
    const sid = typeof req.body.session_id === 'string' && /^[a-z0-9-]{8,64}$/i.test(req.body.session_id)
      ? req.body.session_id : null;
    if (sid) {
      const userMsg = clean[clean.length - 1].content;
      pool.query(
        `INSERT INTO concierge_messages (profile, session_id, role, content) VALUES ($1,$2,$3,$4)`,
        [req.params.profile, sid, 'user', userMsg]
      ).then(() => pool.query(
        `INSERT INTO concierge_messages (profile, session_id, role, content) VALUES ($1,$2,$3,$4)`,
        [req.params.profile, sid, 'assistant', reply]
      )).catch(e => console.error('[concierge] transcript insert failed:', e.message));
    }
    res.json({ reply });
  } catch (err) {
    console.error('POST /api/concierge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Live diary grounding: booked ranges for the next 7 days, computed server-side
// so the AI reads availability instead of inventing it. One-therapist demo model.
const LONDON = 'Europe/London';
function _lonDate(d) { return d.toLocaleDateString('en-GB', { timeZone: LONDON, weekday: 'short', day: 'numeric', month: 'short' }); }
function _lonHM(d) { return d.toLocaleTimeString('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hour12: false }); }
function _lonYMD(d) { return d.toLocaleDateString('en-CA', { timeZone: LONDON }); }
async function _conciergeDiary(profileId, profile) {
  try {
    const now = new Date();
    const r = await pool.query(
      `SELECT customer_name, treatment, minutes, start_at FROM concierge_bookings
       WHERE profile = $1 AND status <> 'cancelled' ORDER BY start_at ASC LIMIT 200`, [profileId]);
    const byDay = new Map();
    r.rows.forEach(b => {
      const start = new Date(b.start_at);
      const end = new Date(start.getTime() + b.minutes * 60000);
      if (end < now || start.getTime() > now.getTime() + 7 * 86400000) return;
      const key = _lonYMD(start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(_lonHM(start) + '–' + _lonHM(end));
    });
    const lines = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const booked = byDay.get(_lonYMD(d));
      lines.push(_lonDate(d) + ' (' + _lonYMD(d) + '): ' + (booked && booked.length ? 'booked ' + booked.join(', ') : 'free all day'));
    }
    return 'DIARY — right now it is ' + _lonDate(now) + ' ' + _lonHM(now)
      + ' (UK time). Open ' + String(profile.open_hour).padStart(2, '0') + ':00–' + profile.close_hour + ':00 daily. Booked ranges for the next 7 days:\n'
      + lines.join('\n')
      + '\nEverything not listed as booked (and inside opening hours, finishing by close, and not in the past) is available.';
  } catch (e) {
    console.error('[concierge] diary build failed:', e.message);
    return '';
  }
}

// Booking creation — validates the slot server-side (hours + overlap) so a
// stale/hand-edited link can never double-book. Demo payment (SEPOS-034
// mock-pay pattern); real Stripe lands when the client signs.
app.post('/api/concierge/:profile/book', async (req, res) => {
  try {
    const concierge = require('./services/conciergeService');
    const profile = _conciergeCors(req, res) || concierge.getProfile(req.params.profile);
    if (!profile || !profile.treatments) return res.status(404).json({ error: 'unknown profile' });
    const { t, d, when, name, phone, session_id } = req.body || {};
    const treatment = profile.treatments[t];
    const minutes = parseInt(d, 10);
    if (!treatment) return res.status(400).json({ error: 'Unknown treatment.' });
    if (!treatment.prices[minutes]) return res.status(400).json({ error: 'That duration is not offered for this treatment.' });
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Please give a name for the booking.' });
    if (!phone || String(phone).replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please give a contact number so May can reach you.' });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(when))) return res.status(400).json({ error: 'Invalid time.' });
    const start = ukLocalToUtc(when); // demo: UK summer offset
    const end = new Date(start.getTime() + minutes * 60000);
    if (isNaN(start) || start < new Date()) return res.status(400).json({ error: 'That time is in the past — please pick a new one in the chat.' });
    const sh = parseInt(when.slice(11, 13), 10), sm = parseInt(when.slice(14, 16), 10);
    const endMins = sh * 60 + sm + minutes;
    if (sh < profile.open_hour || endMins > profile.close_hour * 60) {
      return res.status(400).json({ error: 'That time falls outside opening hours (10am–8pm).' });
    }
    // Overlap check in JS (dialect-safe).
    const dayRows = await pool.query(
      `SELECT minutes, start_at FROM concierge_bookings WHERE profile = $1 AND status <> 'cancelled'`, [req.params.profile]);
    const clash = dayRows.rows.some(b => {
      const bs = new Date(b.start_at); const be = new Date(bs.getTime() + b.minutes * 60000);
      return bs < end && be > start;
    });
    if (clash) return res.status(409).json({ error: 'Sorry — that slot has just been taken. Pop back to the chat and pick another time.' });
    await pool.query(
      `INSERT INTO concierge_bookings (profile, session_id, customer_name, customer_phone, treatment, minutes, start_at, deposit_gbp, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid_demo')`,
      [req.params.profile, (typeof session_id === 'string' && session_id.slice(0, 64)) || null,
       String(name).trim().slice(0, 120), String(phone).trim().slice(0, 40),
       treatment.label, minutes, start.toISOString(), profile.deposit_gbp || 0]);
    res.json({ ok: true, label: treatment.label, price: treatment.prices[minutes], deposit: profile.deposit_gbp || 0 });
  } catch (err) {
    console.error('POST /api/concierge/book error:', err);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

// The booking + demo-payment page the bot links to. Mobile-first, self-contained.
app.get('/concierge-book/:profile', (req, res) => {
  const concierge = require('./services/conciergeService');
  const profile = concierge.getProfile(req.params.profile);
  if (!profile || !profile.treatments) return res.status(404).send('Not found');
  const t = String(req.query.t || ''); const d = parseInt(req.query.d, 10);
  const when = String(req.query.when || ''); const name = String(req.query.name || '').slice(0, 60);
  const tr = profile.treatments[t];
  const ok = tr && tr.prices[d] && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when);
  const price = ok ? tr.prices[d] : 0; const dep = profile.deposit_gbp || 0;
  const whenNice = ok ? ukLocalToUtc(when).toLocaleString('en-GB', { timeZone: LONDON, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<title>Book — ${e(profile.display_name)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F8F1E8;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:0 16px 40px}
header{background:#2E362E;color:#fff;width:100vw;padding:calc(env(safe-area-inset-top) + 16px) 20px 16px;text-align:center}
h1{font-size:18px;font-weight:600}.sub{font-size:12.5px;opacity:.8;margin-top:2px}
.card{background:#fff;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.08);max-width:430px;width:100%;margin-top:20px;padding:22px}
.rowl{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0ece4;font-size:15px}
.rowl b{text-align:right}.tot{font-size:16px;border-bottom:none;padding-top:12px}
label{display:block;font-size:13px;color:#556;margin:14px 0 5px}
input{width:100%;padding:12px;border:1px solid #ddd;border-radius:9px;font-size:16px}
button{width:100%;margin-top:18px;padding:15px;border:none;border-radius:10px;background:#2E362E;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}.demo{margin-top:10px;text-align:center;font-size:11.5px;color:#998}
.err{background:#fdecea;color:#b3261e;border-radius:9px;padding:12px;font-size:14px;margin-top:14px;display:none}
.done{display:none;text-align:center;padding:14px 0}.done .tick{font-size:52px}.done h2{font-size:19px;margin:10px 0 6px}.done p{color:#556;font-size:14.5px;line-height:1.5}
</style></head><body>
<header><h1>${e(profile.display_name)}</h1><div class="sub">Secure booking · Kensington Church Street, W8</div></header>
<div class="card" id="card">${ok ? `
  <div class="rowl"><span>Treatment</span><b>${e(tr.label)}</b></div>
  <div class="rowl"><span>Duration</span><b>${d} minutes</b></div>
  <div class="rowl"><span>When</span><b>${e(whenNice)}</b></div>
  <div class="rowl"><span>Price on the day</span><b>£${price - dep} (after deposit)</b></div>
  <div class="rowl tot"><span>Deposit to pay now</span><b>£${dep}</b></div>
  <label>Your name</label><input id="nm" value="${e(name)}" autocomplete="name">
  <label>Mobile number (May will confirm on this)</label><input id="ph" type="tel" inputmode="tel" autocomplete="tel" placeholder="07…">
  <button id="pay">Pay £${dep} deposit &amp; confirm</button>
  <div class="demo">Demo checkout — no real card is charged. Live payments use Stripe.</div>
  <div class="err" id="err"></div>
  <div class="done" id="done"><div class="tick">✅</div><h2>Booking confirmed!</h2><p id="dmsg"></p></div>
` : `<div class="done" style="display:block"><div class="tick">🤔</div><h2>This link looks incomplete</h2><p>Please go back to the chat and ask for a fresh booking link.</p></div>`}</div>
${ok ? `<script>
var q=new URLSearchParams(location.search);
document.getElementById('pay').addEventListener('click',function(){
  var b=this;b.disabled=true;b.textContent='Processing…';
  var err=document.getElementById('err');err.style.display='none';
  fetch('/api/concierge/${e(req.params.profile)}/book',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    t:q.get('t'),d:q.get('d'),when:q.get('when'),name:document.getElementById('nm').value,phone:document.getElementById('ph').value,session_id:(function(){try{return sessionStorage.getItem('jw-sid')||null}catch(e){return null}})()
  })}).then(function(r){return r.json().then(function(j){return{s:r.status,j:j}})}).then(function(x){
    if(x.j&&x.j.ok){
      ['nm','ph','pay'].forEach(function(i){document.getElementById(i).style.display='none'});
      document.querySelector('.demo').style.display='none';
      var dn=document.getElementById('done');dn.style.display='block';
      document.getElementById('dmsg').textContent='£'+x.j.deposit+' deposit received (demo). '+x.j.label+' — see you then! May has your booking and will message if anything changes.';
    } else { err.textContent=(x.j&&x.j.error)||'Something went wrong — try again.';err.style.display='block';b.disabled=false;b.textContent='Pay £${dep} deposit & confirm'; }
  }).catch(function(){err.textContent='Connection problem — try again.';err.style.display='block';b.disabled=false;b.textContent='Pay £${dep} deposit & confirm';});
});
</script>` : ''}</body></html>`);
});

// Owner inbox (demo): private-key URL, mobile-first. Real product = SiamSpa admin tab.
function _conciergeInboxAuth(req, res) {
  const concierge = require('./services/conciergeService');
  const profile = concierge.getProfile(req.params.profile);
  if (!profile || !profile.inbox_key || req.query.key !== profile.inbox_key) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return profile;
}
const CONCIERGE_BOOKING_RE = /book|จอง|appointment|reserve|tomorrow|tonight|พรุ่งนี้|คืนนี้/i;
app.get('/api/concierge/:profile/inbox', async (req, res) => {
  try {
    if (!_conciergeInboxAuth(req, res)) return;
    const r = await pool.query(
      `SELECT session_id, role, content, created_at FROM concierge_messages
       WHERE profile = $1 ORDER BY id DESC LIMIT 600`, [req.params.profile]);
    const sessions = new Map();
    // rows are newest-first; first row seen per session = its latest message
    r.rows.forEach(m => {
      let s = sessions.get(m.session_id);
      if (!s) {
        s = { session_id: m.session_id, last_at: m.created_at, preview: '', count: 0, booking: false };
        sessions.set(m.session_id, s);
      }
      s.count++;
      if (!s.preview && m.role === 'user') s.preview = String(m.content).slice(0, 120);
      if (m.role === 'user' && CONCIERGE_BOOKING_RE.test(m.content)) s.booking = true;
    });
    let bookings = [];
    try {
      const br = await pool.query(
        `SELECT customer_name, customer_phone, treatment, minutes, start_at, deposit_gbp, status
         FROM concierge_bookings WHERE profile = $1 AND status <> 'cancelled'
         ORDER BY start_at ASC LIMIT 100`, [req.params.profile]);
      const cutoff = Date.now() - 12 * 3600000;
      bookings = br.rows.filter(b => new Date(b.start_at).getTime() > cutoff);
    } catch (e) { /* table may not exist on old tills — inbox still works */ }
    res.json({ sessions: Array.from(sessions.values()).slice(0, 60), bookings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/concierge/:profile/thread/:session', async (req, res) => {
  try {
    if (!_conciergeInboxAuth(req, res)) return;
    const r = await pool.query(
      `SELECT role, content, created_at FROM concierge_messages
       WHERE profile = $1 AND session_id = $2 ORDER BY id ASC LIMIT 200`,
      [req.params.profile, req.params.session]);
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/concierge-inbox/:profile', (req, res) => {
  const profile = _conciergeInboxAuth(req, res);
  if (!profile) return;
  const name = profile.display_name || req.params.profile;
  res.type('html').send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${name} — Chat inbox</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ECE5DD;min-height:100dvh}
  header{background:#075E54;color:#fff;padding:calc(env(safe-area-inset-top) + 14px) 16px 14px;position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px}
  header h1{font-size:17px;font-weight:600;flex:1}
  header .sub{font-size:12px;opacity:.85}
  #back{display:none;background:none;border:none;color:#fff;font-size:24px;padding:2px 8px 2px 0;cursor:pointer}
  .row{background:#fff;padding:14px 16px;border-bottom:1px solid #eee;display:flex;gap:12px;align-items:center;cursor:pointer}
  .row:active{background:#f2f2f2}
  .ava{width:46px;height:46px;border-radius:50%;background:#2E362E;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;flex:none;font-size:15px}
  .mid{flex:1;min-width:0}
  .who{font-weight:600;font-size:15px;display:flex;gap:6px;align-items:center}
  .pv{color:#667;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
  .meta{text-align:right;flex:none}
  .t{color:#889;font-size:12px}
  .n{display:inline-block;background:#25D366;color:#fff;border-radius:10px;font-size:11px;padding:1px 7px;margin-top:5px}
  .pin{font-size:13px}
  .empty{padding:48px 24px;text-align:center;color:#778}
  #thread{display:none;padding:12px;flex-direction:column;gap:8px}
  .b{max-width:84%;padding:8px 12px;border-radius:10px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08)}
  .u{background:#fff;align-self:flex-start;border-top-left-radius:2px}
  .a{background:#DCF8C6;align-self:flex-end;border-top-right-radius:2px}
  .b .ts{display:block;font-size:10.5px;color:#99a;margin-top:4px;text-align:right}
  .note{font-size:11.5px;color:#889;text-align:center;padding:10px}
</style></head><body>
<header><button id="back" aria-label="Back">&#8249;</button><div style="flex:1"><h1>${name}</h1><div class="sub" id="sub">Customer chats · AI assistant</div></div></header>
<div id="list"></div><div id="thread"></div>
<div class="note">Guests are anonymous until they share contact details in chat. 📌 = possible booking request.</div>
<script>
var KEY=new URLSearchParams(location.search).get('key');
var P=${JSON.stringify(req.params.profile)};
var listEl=document.getElementById('list'),thEl=document.getElementById('thread'),backEl=document.getElementById('back'),subEl=document.getElementById('sub');
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
function ago(t){var s=(Date.now()-new Date(t).getTime())/1000;if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d'}
function bookingsHtml(bs){
  if(!bs||!bs.length)return '';
  return '<div style="background:#E7F6EC;padding:10px 16px;font-size:13px;font-weight:600;color:#1a6b3c">Confirmed bookings · '+bs.length+'</div>'
    +bs.map(function(b){
      var w=new Date(b.start_at).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      return '<div class="row" style="cursor:default"><div class="ava" style="background:#1a6b3c">✓</div>'
        +'<div class="mid"><div class="who">'+esc(b.customer_name)+' · '+esc(w)+'</div>'
        +'<div class="pv">'+esc(b.treatment)+' · '+b.minutes+'min · £'+b.deposit_gbp+' deposit paid'+(b.customer_phone?' · '+esc(b.customer_phone):'')+'</div></div></div>';
    }).join('');
}
function load(){fetch('/api/concierge/'+P+'/inbox?key='+encodeURIComponent(KEY)).then(r=>r.json()).then(function(d){
  var ss=(d&&d.sessions)||[];
  var bh=bookingsHtml((d&&d.bookings)||[]);
  if(!ss.length&&!bh){listEl.innerHTML='<div class="empty">No chats yet.<br>They\\'ll appear here the moment a customer messages the assistant.</div>';return}
  listEl.innerHTML=bh+ss.map(function(s){
    return '<div class="row" data-s="'+esc(s.session_id)+'"><div class="ava">'+esc(s.session_id.slice(-2).toUpperCase())+'</div>'
      +'<div class="mid"><div class="who">Guest '+esc(s.session_id.slice(-4))+(s.booking?' <span class="pin">📌</span>':'')+'</div>'
      +'<div class="pv">'+esc(s.preview||'…')+'</div></div>'
      +'<div class="meta"><div class="t">'+ago(s.last_at)+'</div><div class="n">'+s.count+'</div></div></div>';
  }).join('');
  Array.prototype.forEach.call(listEl.querySelectorAll('.row'),function(r){r.addEventListener('click',function(){openThread(r.getAttribute('data-s'))})});
})}
function openThread(sid){
  fetch('/api/concierge/'+P+'/thread/'+encodeURIComponent(sid)+'?key='+encodeURIComponent(KEY)).then(r=>r.json()).then(function(d){
    listEl.style.display='none';thEl.style.display='flex';backEl.style.display='block';
    subEl.textContent='Guest '+sid.slice(-4);
    thEl.innerHTML=((d&&d.messages)||[]).map(function(m){
      return '<div class="b '+(m.role==='user'?'u':'a')+'">'+esc(m.content)+'<span class="ts">'+new Date(m.created_at).toLocaleString('en-GB',{hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'})+'</span></div>';
    }).join('');
    window.scrollTo(0,document.body.scrollHeight);
  });
}
backEl.addEventListener('click',function(){thEl.style.display='none';backEl.style.display='none';listEl.style.display='block';subEl.textContent='Customer chats · AI assistant';load()});
load();setInterval(function(){if(listEl.style.display!=='none')load()},25000);
</script></body></html>`);
});

app.get('/api/expenses', async (req, res) => {
  try { const result = await pool.query(`SELECT * FROM expenses ORDER BY date DESC, created_at DESC`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'description and amount are required' });
    // SEPOS-048 — default the expense to the restaurant's date, not UTC's.
    const result = await pool.query(`INSERT INTO expenses (category, description, amount, date) VALUES ($1,$2,$3,$4) RETURNING id`, [category || 'other', description, parseFloat(amount), date || dateInZone(new Date(), await restaurantTz())]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try { const result = await pool.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]); res.json({ success: true, deleted: result.rowCount }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-046 (Nook's POTENTIAL BUG #2) — recipe costs were stored at save time
// and never refreshed, so after a supplier price change every food-cost %
// badge and the wastage report kept costing dishes at the OLD ingredient
// price. Called from the invoice confirm below for the ingredients whose
// cost actually changed: refresh each affected recipe_line from the CURRENT
// cost/yield (same formula as client calcLineCost), then re-foot the recipe.
async function recalcRecipesForIngredients(client, ingredientIds) {
  if (!ingredientIds.length) return 0;
  const linesRes = await client.query(
    `SELECT rl.id, rl.recipe_id, rl.quantity_used, i.cost_per_unit, i.yield_percentage
       FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id
      WHERE rl.ingredient_id = ANY($1::int[])`,
    [ingredientIds]
  );
  if (!linesRes.rows.length) return 0;
  for (const l of linesRes.rows) {
    const q = Number(l.quantity_used) || 0;
    const c = Number(l.cost_per_unit) || 0;
    const y = Number(l.yield_percentage) || 100;
    const lineCost = (!q || !c) ? 0 : (q * c) / (y / 100);
    await client.query(`UPDATE recipe_lines SET line_cost = $1 WHERE id = $2`, [lineCost, l.id]);
  }
  const recipeIds = [...new Set(linesRes.rows.map(r => r.recipe_id))];
  for (const rid of recipeIds) {
    await client.query(
      `UPDATE recipes SET
         total_cost = (SELECT COALESCE(SUM(line_cost), 0) FROM recipe_lines WHERE recipe_id = $1),
         cost_per_portion = (SELECT COALESCE(SUM(line_cost), 0) FROM recipe_lines WHERE recipe_id = $1)
                            / CASE WHEN COALESCE(serves, 1) > 0 THEN COALESCE(serves, 1) ELSE 1 END,
         last_calculated = NOW()
       WHERE id = $1`,
      [rid]
    );
  }
  return recipeIds.length;
}

// ── SEPOS-INV-UNITS-001 — unit intelligence for invoice confirm ──────────────
// Invoices arrive in purchase-world units (each, bottle, case, L); recipes cost
// in usage-world units (ml, g, kg). Reconciling wrongly is worse than refusing:
// stamping a £8/each price onto a per-kg ingredient silently corrupts stock AND
// every recipe cost. Rules, in priority order:
//   1. Same unit (after aliasing)            → apply as-is
//   2. Pure metric conversion (L↔ml, kg↔g)   → convert qty ×1000 / cost ÷1000
//   3. Ingredient's purchase bridge          → line unit == purchase_unit and
//      purchase_to_usage set ("1 each = 2.1 kg") → qty×factor, cost÷factor
//   4. AI-extracted pack info                → "6 × 1L @ £30/bottle" with a
//      metric pack unit convertible to the usage unit
//   5. Nothing reconciles                    → SKIP the line and REPORT it —
//      never guess with money.
const UNIT_ALIASES = {
  l: 'l', ltr: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  ml: 'ml', mls: 'ml', millilitre: 'ml', milliliter: 'ml',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gr: 'g', gram: 'g', grams: 'g',
  each: 'each', ea: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each', unit: 'each', units: 'each', x: 'each',
  bottle: 'bottle', bottles: 'bottle', btl: 'bottle',
  case: 'case', cases: 'case', box: 'case', boxes: 'case', pack: 'case', packs: 'case', pk: 'case',
  tin: 'tin', tins: 'tin', can: 'tin', cans: 'tin',
  bag: 'bag', bags: 'bag', sack: 'bag',
};
function normalizeUnit(u) {
  const k = String(u || '').trim().toLowerCase().replace(/[.]/g, '');
  return UNIT_ALIASES[k] || k;
}
// Millilitres/grams per one of the given metric unit; null = not metric.
const METRIC_BASE = { l: { base: 'ml', per: 1000 }, ml: { base: 'ml', per: 1 }, kg: { base: 'g', per: 1000 }, g: { base: 'g', per: 1 } };
// How many `toU` are in one `fromU` — 1 for same unit, ×1000/÷1000 across a
// metric family, null when the units are unrelated (each vs kg etc.).
function unitsPerUnit(fromU, toU) {
  const f = normalizeUnit(fromU), t = normalizeUnit(toU);
  if (!f || !t) return null;
  if (f === t) return 1;
  const mf = METRIC_BASE[f], mt = METRIC_BASE[t];
  if (mf && mt && mf.base === mt.base) return mf.per / mt.per;
  return null;
}
// Resolve an invoice line against an ingredient. Returns
// { usageQty, usageCost, how } or null when irreconcilable.
function reconcileInvoiceLine(item, qty, unitPrice, ing) {
  const lineU = normalizeUnit(item.unit);
  const ingU  = normalizeUnit(ing.unit);
  // 1+2 — same unit or metric family
  const per = unitsPerUnit(lineU, ingU);
  if (per != null) {
    return { usageQty: qty * per, usageCost: unitPrice / per, how: per === 1 ? 'same-unit' : `metric ${lineU}→${ingU}` };
  }
  // 3 — the ingredient's configured purchase bridge (e.g. 1 each = 2.1 kg)
  const bridgeU = normalizeUnit(ing.purchase_unit);
  const factor  = Number(ing.purchase_to_usage) || 0;
  if (bridgeU && factor > 0 && lineU === bridgeU) {
    return { usageQty: qty * factor, usageCost: unitPrice / factor, how: `bridge 1 ${bridgeU} = ${factor} ${ingU}` };
  }
  // 4 — AI-extracted pack info ("1L bottle" → pack_size 1, pack_unit L)
  const packSize = Number(item.pack_size) || 0;
  const packPer  = packSize > 0 ? unitsPerUnit(item.pack_unit, ingU) : null;
  if (packPer != null && packSize > 0) {
    const perPurchase = packSize * packPer;
    return { usageQty: qty * perPurchase, usageCost: unitPrice / perPurchase, how: `pack ${packSize} ${normalizeUnit(item.pack_unit)}/${lineU}` };
  }
  return null; // 5 — refuse, never guess
}

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
    const skipped_unit_mismatch = []; // SEPOS-INV-UNITS-001 — refused lines, reported loudly

    // 2. Process each line item
    for (const item of (line_items || [])) {
      const qty       = parseFloat(item.quantity)   || 0;
      const unitPrice = parseFloat(item.unit_price) || 0;
      if (qty <= 0) continue;

      if (item.matched_ingredient_id) {
        // Matched to an existing ingredient
        const ingRes = await client.query(
          `SELECT id, name_en, unit, cost_per_unit, purchase_unit, purchase_to_usage FROM ingredients WHERE id = $1`,
          [item.matched_ingredient_id]
        );
        if (ingRes.rows.length === 0) continue;
        const ing = ingRes.rows[0];
        const oldCost = parseFloat(ing.cost_per_unit) || 0;

        // SEPOS-INV-UNITS-001 — reconcile invoice units to the ingredient's
        // usage unit, or refuse the line. Stamping mismatched units corrupted
        // both stock and every recipe cost (the old code applied blindly).
        const rec = reconcileInvoiceLine(item, qty, unitPrice, ing);
        if (!rec) {
          skipped_unit_mismatch.push({
            name: item.name || ing.name_en,
            invoice_unit: item.unit || '?',
            ingredient_unit: ing.unit || '?',
            hint: `Set a purchase bridge on "${ing.name_en}" (e.g. 1 ${normalizeUnit(item.unit) || 'each'} = X ${ing.unit}) or edit the line to ${ing.unit}.`,
          });
          continue;
        }
        const newCost = Math.round(rec.usageCost * 10000) / 10000;

        await client.query(
          `UPDATE ingredients
           SET current_stock = current_stock + $1,
               cost_per_unit = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [rec.usageQty, newCost, ing.id]
        );

        await client.query(
          `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
           VALUES ($1, 'delivery', $2, $3, $4, $5)`,
          [ing.id, rec.usageQty, newCost, `Invoice ${invoice_number || ''}${rec.how !== 'same-unit' ? ` (${rec.how})` : ''}`, `invoice:${invoiceId}`]
        );

        updated.push(ing.name_en);

        if (Math.abs(newCost - oldCost) > 0.001) {
          price_changes.push({ id: ing.id, name: ing.name_en, old_cost: oldCost, new_cost: newCost });
        }

      } else {
        // No match — auto-create a new ingredient.
        // SEPOS-INV-UNITS-001 — when the AI extracted metric pack info
        // ("2 bottles × 1L @ £35"), create the ingredient straight in the
        // metric base unit (ml/g) with the pro-rated cost, so recipes can use
        // it in real ml/g from day one. A purchase bridge is stored too, so
        // the NEXT invoice ("each"/"bottle" lines) reconciles automatically.
        const newName = item.name_extracted || item.name || 'Unknown Item';
        let cUnit = item.unit || 'unit', cQty = qty, cCost = unitPrice, cPU = null, cPTU = null;
        const packSize = Number(item.pack_size) || 0;
        const packU = normalizeUnit(item.pack_unit);
        if (packSize > 0 && METRIC_BASE[packU]) {
          const base = METRIC_BASE[packU];
          const perPurchase = packSize * base.per;      // usage units per each/bottle/case
          cUnit = base.base;                            // 'ml' or 'g'
          cQty  = qty * perPurchase;
          cCost = Math.round((unitPrice / perPurchase) * 10000) / 10000;
          cPU   = normalizeUnit(item.unit) || 'each';
          cPTU  = perPurchase;
        }
        const newIng = await client.query(
          `INSERT INTO ingredients (name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, supplier_name, purchase_unit, purchase_to_usage, updated_at)
           VALUES ($1, '', $2, $3, 100, 'Other', $4, $5, $6, $7, NOW())
           RETURNING id, name_en`,
          [newName, cUnit, cCost, cQty, supplier_name || '', cPU, cPTU]
        );

        await client.query(
          `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
           VALUES ($1, 'delivery', $2, $3, $4, $5)`,
          [newIng.rows[0].id, cQty, cCost, `Invoice ${invoice_number || ''} (auto-created)`, `invoice:${invoiceId}`]
        );

        created.push(newName);
      }
    }

    // 3. SEPOS-046 — refresh recipe costs for price-changed ingredients so
    // food-cost badges and the wastage report track the new supplier price.
    const recipes_recalculated = await recalcRecipesForIngredients(
      client, price_changes.map(p => p.id).filter(Boolean)
    );

    // 4. Return everything the frontend needs for the done screen
    await client.query('COMMIT');
    res.json({ id: invoiceId, success: true, created, updated, price_changes, recipes_recalculated, skipped_unit_mismatch });

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

// (auth note) GET /api/vouchers and GET /api/voucher-redemptions are gated
// with requireStaffAuthOrSyncSecret — Nook's REG-1 (2026-07-14): both leaked
// voucher codes/balances/redemptions to the anonymous internet. Staff UIs
// send the Bearer token (api.js attaches it globally); the desktop pull
// sends x-sync-secret. The public widget balance check stays on
// GET /api/widget/voucher/:code (exact-code lookup only).

// SEPOS-046 — itemised detail for the invoice history expander. The confirm
// endpoint already writes one stock_movements row per line with
// reference='invoice:<id>', so the lines live there (including for every
// invoice recorded since the transaction fix shipped) — no new table needed.
app.get('/api/supplier-invoices/:id/lines', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sm.quantity, sm.cost_at_time, sm.note, sm.created_at,
              i.name_en, i.unit
         FROM stock_movements sm
         LEFT JOIN ingredients i ON i.id = sm.ingredient_id
        WHERE sm.reference = $1
        ORDER BY sm.id ASC`,
      [`invoice:${parseInt(req.params.id, 10) || 0}`]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const { name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens, purchase_unit, purchase_to_usage } = req.body;
    const result = await pool.query(`INSERT INTO ingredients (name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens, purchase_unit, purchase_to_usage, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`, [name_en, name_th || '', unit || 'kg', parseFloat(cost_per_unit) || 0, parseFloat(yield_percentage) || 100, category || 'Other', parseFloat(current_stock) || 0, par_level ? parseFloat(par_level) : null, supplier_name || '', allergens || '[]', purchase_unit || null, purchase_to_usage ? parseFloat(purchase_to_usage) : null]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/ingredients/:id', async (req, res) => {
  try {
    const { name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens, purchase_unit, purchase_to_usage } = req.body;
    const result = await pool.query(`UPDATE ingredients SET name_en=$1, name_th=$2, unit=$3, cost_per_unit=$4, yield_percentage=$5, category=$6, current_stock=$7, par_level=$8, supplier_name=$9, allergens=$10, purchase_unit=$11, purchase_to_usage=$12, updated_at=NOW() WHERE id=$13`, [name_en, name_th || '', unit || 'kg', parseFloat(cost_per_unit) || 0, parseFloat(yield_percentage) || 100, category || 'Other', parseFloat(current_stock) || 0, par_level ? parseFloat(par_level) : null, supplier_name || '', allergens || '[]', purchase_unit || null, purchase_to_usage ? parseFloat(purchase_to_usage) : null, req.params.id]);
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
    // SEPOS-ALLERGEN-LOCAL-001 — on a local install the cloud copy is what the
    // QR menu chips + other devices read, so replicate there too: forward when
    // reachable, queue a config_write replay when not. The LOCAL write below
    // still runs either way so the sheet reads back correctly on this till.
    try {
      const archiveService = require('./services/archiveService');
      if (archiveService.isLocalInstall() && process.env.CLOUD_API_URL) {
        try {
          const r = await fetch(`${process.env.CLOUD_API_URL}/api/dish-allergens/${menuItemId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(process.env.SYNC_SECRET ? { 'x-sync-secret': process.env.SYNC_SECRET } : {}) },
            body: JSON.stringify({ allergens }),
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error(`cloud ${r.status}`);
        } catch (fwdErr) {
          await offlineQueue.enqueue('config_write', { method: 'POST', path: `/api/dish-allergens/${menuItemId}`, body: { allergens } });
          console.warn('[dish-allergens] cloud replicate queued:', fwdErr.message);
        }
      }
    } catch { /* forward best-effort — local save is the source of truth for this till */ }
    // CURRENT_TIMESTAMP (not NOW()) — valid on BOTH PostgreSQL and SQLite;
    // NOW() made every manual tick 500 on local tills.
    const result = await pool.query(`INSERT INTO dish_allergens (menu_item_id, allergens, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (menu_item_id) DO UPDATE SET allergens = EXCLUDED.allergens, updated_at = EXCLUDED.updated_at RETURNING id`, [menuItemId, allergens || '[]']);
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
app.get('/api/network-info', async (req, res) => {
  const os = require('os');
  const port = process.env.PORT || 3001;
  // Only a LOCAL install (desktop / Sunmi host) is a real LAN host worth
  // pointing tablets at. On the cloud (Railway) this endpoint would otherwise
  // report the datacenter container's private IP (e.g. 10.x:8080) — a real
  // address, but meaningless outside the container. `local` lets the client
  // hide the LAN "Network Setup" card in the cloud web app.
  const local = String(process.env.DB_MODE || '').toLowerCase() === 'local';
  // Prefer the Wi-Fi/Ethernet LAN interface: 192.168.x first, then other
  // private ranges — so a machine with both Wi-Fi and a cellular/hotspot
  // interface reports the address tablets can actually reach.
  const os_ = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(os_)) {
    if (/^(tun|utun|tap|ipsec|vpn|wg|zt)/i.test(name)) continue;
    for (const iface of (os_[name] || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(iface.address)) {
        candidates.push(iface.address);
      }
    }
  }
  // 192.168.x are ordinary home/shop routers — the address tablets share.
  candidates.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
  // SEPOS-BILL-STATIONS follow-up — the host can carry interface ALIASES
  // (the travelling printer-kit bridge adds 192.168.8.50 / 192.168.1.50),
  // and "first candidate" then advertises an address tablets can't reach
  // ("cannot open the IP, it's not loading" — Korakot, 2026-08-06). Ask the
  // OS routing table instead: a UDP connect (no packet is ever sent)
  // resolves the outbound source IP — the address on the REAL LAN.
  let routed = null;
  try {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => sock.connect(53, '8.8.8.8', (e) => (e ? reject(e) : resolve())));
    routed = sock.address().address;
    sock.close();
  } catch { /* offline / no default route — fall back to candidates */ }
  const ip = (routed && candidates.includes(routed)) ? routed : (candidates[0] || '127.0.0.1');
  res.json({ ip, port, url: `http://${ip}:${port}`, local });
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
      `SELECT key, value FROM settings WHERE key IN ('restaurant_postcode','delivery_radius_miles','takeaway_discount_percent')`
    );
    const cfg = {};
    dr.rows.forEach(row => { cfg[row.key] = row.value; });
    const deliveryEnabled = !!(cfg.restaurant_postcode && Number(cfg.delivery_radius_miles) > 0);
    // SEPOS-TAKEAWAY-DISCOUNT — optional % off online takeaway orders (Chart
    // Thai ask, 2026-07-21). 0 = off. Clamped 0–50 as a fat-finger guard; the
    // order endpoint clamps identically so widget and server always agree.
    const discountPercent = Math.min(50, Math.max(0, Number(cfg.takeaway_discount_percent) || 0));
    res.json({
      ...(r.rows[0] || {}),
      delivery_enabled: deliveryEnabled,
      delivery_radius_miles: deliveryEnabled ? Number(cfg.delivery_radius_miles) : 0,
      discount_percent: discountPercent,
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
  await ensureOpenSession(resolveRestaurantId(req)); // SEPOS-AUTO-SESSION-001
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
    // SEPOS-TA-COLLECT-001 (Baanrai, 25 Aug) — a no-Stripe takeaway order is
    // PAY ON COLLECTION, not a demo: it lands 'unpaid' so the till's bill
    // shows the balance due and staff record the real cash/card tender at
    // the counter (Z + drawer stay honest). The old 'mock' made the bill
    // say "PAID ONLINE (demo) — do not charge", which is only right for the
    // QR demo flow — that keeps its own 'mock' (prepaid semantics) below.
    let paymentStatus = 'unpaid';
    let verifiedPaymentIntentId = null;
    let verifiedPaymentPence = null;
    if (payment_intent_id) {
      const spVerify = siampayCfg();
      if (!process.env.STRIPE_SECRET_KEY && !spVerify) {
        return res.status(400).json({ error: 'Stripe not configured — cannot verify payment' });
      }
      try {
        // SIAMPAY-002 — a SiamPay PI lives on the CONNECTED account, so the
        // retrieve must carry the stripeAccount header to find it.
        const pi = spVerify
          ? await require('stripe')(spVerify.key).paymentIntents.retrieve(payment_intent_id, {}, { stripeAccount: spVerify.account })
          : await require('stripe')(process.env.STRIPE_SECRET_KEY).paymentIntents.retrieve(payment_intent_id);
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
    // SEPOS-TA-HOURS-001 (Korakot, 25 Aug — "why can I order when the
    // restaurant is closed?"): the hours guard was gated on a
    // restaurant_settings ROW existing, so freshly-provisioned tenants
    // (no row) accepted orders around the clock — FAIL-OPEN on a money
    // path. Validate ALWAYS: with no row, the per-field defaults below
    // (11:00–21:30, Europe/London) apply until the venue sets real hours.
    const settings = settingsRes.rows[0] || {};
    {
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

    // SEPOS-TAKEAWAY-DISCOUNT — optional % off online orders (Chart Thai,
    // 2026-07-21). Applied server-side BEFORE the paid-amount check so a
    // tampered widget can't claim a bigger discount than the setting allows;
    // clamped identically to /api/takeaway/settings so both sides agree.
    let discountPercent = 0;
    try {
      const dset = await client.query(`SELECT value FROM settings WHERE key = 'takeaway_discount_percent'`);
      discountPercent = Math.min(50, Math.max(0, Number(dset.rows[0]?.value) || 0));
    } catch { /* setting absent → no discount */ }
    if (discountPercent > 0) {
      total = Math.round(total * (1 - discountPercent / 100) * 100) / 100;
    }

    // SEPOS-047b — the paid amount must match the server-priced total.
    // A mismatch means menu prices changed mid-checkout or the widget
    // was tampered with; either way the order must not land as 'paid'.
    // SIAMPAY-002 (Korakot 21 Jul): the customer pays the menu price ONLY.
    // The flat SiamPay fee is application_fee_amount — deducted from the
    // client's settlement by Stripe, never added on top for the customer.
    const expectedPence = Math.round(total * 100);
    if (verifiedPaymentIntentId !== null && verifiedPaymentPence !== expectedPence) {
      console.warn(`[takeaway] PI ${verifiedPaymentIntentId} amount ${verifiedPaymentPence}p != expected ${expectedPence}p — rejected`);
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
          restaurant_id, discount_type, discount_value, discount_reason)
       VALUES (NULL, 'open', 1, $1, NOW(),
               'takeaway', $2, $3, $4,
               $5, 'pending', $6, $7, $8,
               $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [total, customer_name.trim(), customer_phone.trim(), (customer_email || '').trim() || null,
       pickup_time, paymentStatus, verifiedPaymentIntentId, notes || null,
       subtype,
       subtype === 'delivery' ? delivery_address.trim() : null,
       subtype === 'delivery' ? (delivery_notes || '').trim() || null : null,
       marketing_consent ? 1 : 0,
       restaurantId,
       discountPercent > 0 ? 'percent' : null,
       discountPercent > 0 ? discountPercent : null,
       discountPercent > 0 ? 'Online order discount' : null]
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
            // SEPOS-STATION-003 — dish-level printer override wins over category.
            `SELECT mi.id, COALESCE(c.is_bar, 0) AS is_bar, COALESCE(mi.printer_id, c.printer_id) AS printer_id
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
        paid: paymentStatus === 'paid',
      }).catch(err => console.error('[takeaway] email error:', err.message));
    }

    console.log(`🥡 New takeaway #${orderId} · ${customer_name} · £${total.toFixed(2)} · pickup ${pickup_time}`);
    // SEPOS-OWNER-ALERT-001 — backup email to the restaurant (fire-and-forget)
    sendRestaurantAlert(
      `New online order \u00b7 \u00a3${total.toFixed(2)} \u00b7 ${subtype === 'delivery' ? 'DELIVERY' : 'collection ' + new Date(pickup_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}`,
      `<p><b>New online ${subtype === 'delivery' ? 'DELIVERY' : 'collection'} order</b> \u2014 ${paymentStatus === 'paid' ? '\u2705 PAID ONLINE' : '\u{1F4B7} PAY ON COLLECTION'}</p>
       <p>${String(customer_name).replace(/[<>]/g,'')} \u00b7 ${String(customer_phone).replace(/[<>]/g,'')}</p>
       <p>${items.map(i => `${i.quantity}\u00d7 ${String(i.name || '').replace(/[<>]/g,'')}`).join('<br>')}</p>
       <p style="font-size:18px;"><b>Total \u00a3${total.toFixed(2)}</b> \u00b7 ready for ${new Date(pickup_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}</p>`
    ).catch(() => {});
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

// SIAMPAY-002 v1 — SiamPay mode for tenants WITHOUT their own Stripe keys.
// Nick's hard rule (board 21 Jul, Korakot-approved): DIRECT charges on the
// client's connected account — the PaymentIntent lives ON acct_…, money
// settles to the client (merchant of record), we take a flat
// application_fee_amount (default 10p). Never destination charges, never
// transfer_data, never a SiamEPOS balance in the flow (FCA/SEIS posture).
// A tenant's own STRIPE_SECRET_KEY always wins — existing clients unchanged.
// TEST MODE ONLY until solicitor + SEIS sign-offs (see SIAMPAY-002 ticket).
const { siampayCfg } = require('./services/siampay'); // shared with voucherService

app.get('/api/takeaway/stripe-config', widgetCors, async (req, res) => {
  // A restaurant can force mock/demo pay (no card field) even with Stripe keys
  // present, via the `takeaway_mock_pay` setting ('1'). Used for the sales-demo
  // tenant (Baan Siam) so any prospect can complete a takeaway order — the order
  // still reaches the till + sends the confirmation email, just no card charge —
  // regardless of ad blockers that block Stripe.js. Per-restaurant: real client
  // deployments (no flag) keep real Stripe untouched.
  let mock = false, payMode = '';
  try { const s = await loadSettings(); mock = String(s.takeaway_mock_pay || '') === '1'; payMode = String(s.takeaway_pay_mode || ''); } catch {}
  // SEPOS-VOUCHER-KEYS-001 — a tenant can hold live Stripe keys for VOUCHER
  // sales while takeaway stays pay-on-collection: takeaway_pay_mode='collection'
  // forces the no-payment takeaway flow without hiding the keys from
  // voucherService. Orders then land 'unpaid' and the till's Collected guard
  // (SEPOS-TA-COLLECT-001) makes staff take payment — same as a keyless tenant.
  if (payMode === 'collection') return res.json({ configured: false, publishable_key: null });
  const sp = siampayCfg();
  if (!mock && sp) {
    // SIAMPAY-002 — widget must init Stripe.js WITH the connected account so
    // the direct charge confirms in the client's own account context.
    return res.json({
      configured: true,
      publishable_key: sp.pk,
      stripe_account: sp.account,
      // No fee_pence: the SiamPay fee comes out of the client's settlement
      // (application_fee_amount), the customer just pays the menu price.
    });
  }
  const configured = !mock && !!process.env.STRIPE_PUBLISHABLE_KEY && !!process.env.STRIPE_SECRET_KEY;
  res.json({
    configured,
    publishable_key: configured ? (process.env.STRIPE_PUBLISHABLE_KEY || null) : null,
  });
});

app.post('/api/takeaway/payment-intent', widgetCors, async (req, res) => {
  const sp = siampayCfg();
  if (!process.env.STRIPE_SECRET_KEY && !sp) {
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
    const params = {
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
    };
    let pi;
    if (sp) {
      // SIAMPAY-002 — DIRECT charge on the connected account + flat app fee.
      // The client is merchant of record; the fee is Stripe-ledgered to us.
      params.application_fee_amount = sp.feePence;
      pi = await require('stripe')(sp.key).paymentIntents.create(params, { stripeAccount: sp.account });
    } else {
      pi = await require('stripe')(process.env.STRIPE_SECRET_KEY).paymentIntents.create(params);
    }
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

// ═════════════════════════════════════════════════════════════════════════════
// SEPOS-QR-ORDER-001 — QR self-ordering at the table.
// Customer scans the table's QR → mobile menu (photos/allergens/dietary/notes)
// → pays FIRST (SiamPay/Stripe when configured, mock otherwise — same rule as
// the takeaway widget) → order fires the kitchen on the customer's table →
// KDS ticks items served → when everything is served the order closes itself
// (it was already paid). The token encodes the table's permanent id, signed —
// renames/moves/renumbers never invalidate a printed sticker.
// ═════════════════════════════════════════════════════════════════════════════

// SEPOS-AUDIT-002 F22 — the literal fallback made every table token forgeable
// on a tenant that set none of these (guessable secret = guessable token =
// anyone can send orders to any table). Kept for local dev only; in production
// a missing secret disables QR ordering rather than pretending to sign.
const QR_DEV_SECRET = 'siamepos-qr-dev';
const qrSecret = () =>
  process.env.QR_SECRET || process.env.SYNC_SECRET || process.env.UNSUB_SECRET || QR_DEV_SECRET;
const qrSecretIsInsecure = () => qrSecret() === QR_DEV_SECRET && process.env.NODE_ENV === 'production';
const qrSign = (tableId) =>
  crypto.createHmac('sha256', qrSecret()).update(`qr-table:${tableId}`).digest('base64url').slice(0, 20);
const qrToken = (tableId) => `${tableId}.${qrSign(tableId)}`;
function qrVerifyToken(token) {
  const m = /^(\d+)\.([A-Za-z0-9_-]{20})$/.exec(String(token || ''));
  if (!m) return null;
  // timingSafeEqual over the HMAC — not strictly needed for table ids, but free.
  const expect = Buffer.from(qrSign(m[1]));
  const got = Buffer.from(m[2]);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  return Number(m[1]);
}
// SEPOS-QR-PAY-REDO — pay-first safety net. Runs the order-creation critical
// section; if it throws after the card succeeded, the PaymentIntent is refunded
// before the error surfaces. A refund failure is logged loudly and the original
// error still surfaces (never mask why the order failed).
async function runExclusiveWithRefund(piId, sp, lockKey, fn) {
  try {
    return await runExclusive(lockKey, fn);
  } catch (err) {
    if (piId && !(err && err.qrReplay)) {
      try {
        const stripe = sp ? require('stripe')(sp.key) : require('stripe')(process.env.STRIPE_SECRET_KEY);
        await stripe.refunds.create({ payment_intent: piId, reason: 'requested_by_customer' }, sp ? { stripeAccount: sp.account } : undefined);
        console.warn(`[qr] order failed after payment — refunded ${piId}: ${err.message}`);
        err.qrRefunded = true;
      } catch (refundErr) {
        console.error(`[qr] ⚠️ ORDER FAILED AND REFUND FAILED for ${piId} — refund by hand:`, refundErr.message);
        err.qrRefundFailed = true;
      }
    }
    throw err;
  }
}

// AUDIT-002 LOW — the concierge parsed a customer's wall-clock time with a
// hardcoded +01:00 (BST), so every booking taken between late October and late
// March was stored an hour early. Resolve the real UK offset for that date.
function ukLocalToUtc(when) {
  const naive = String(when || '').trim().replace(' ', 'T');
  let t = Date.parse(naive + ':00Z');
  if (Number.isNaN(t)) return new Date(NaN);
  for (let i = 0; i < 2; i++) {
    const asUk = new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T');
    const drift = Date.parse(asUk + 'Z') - Date.parse(naive + ':00Z');
    if (!drift) break;
    t -= drift;
  }
  return new Date(t);
}

async function qrEnabled() {
  try {
    if (qrSecretIsInsecure()) {
      console.error('[qr] REFUSING to serve QR ordering: no QR_SECRET/SYNC_SECRET/UNSUB_SECRET set, so table tokens would be forgeable');
      return false;
    }
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'qr_ordering_enabled'`);
    return String(r.rows[0]?.value || '0') === '1';
  } catch { return false; }
}
// Real card payment is only offered when keys exist AND the demo override is
// off — the SAME rule /api/takeaway/stripe-config applies, or the page would
// try to mount Stripe with a null publishable key on the demo tenant
// (found live on Baan Siam: takeaway_mock_pay=1 but secret key present).
// SEPOS-QR-PAYLATER-001 (Yum Yum, 28 Aug) — per-restaurant policy: 'pay_later'
// lets customers ORDER from the QR page with staff taking payment at the till
// (the order lands 'unpaid'; the prepaid read-only protections key on
// paid/mock so they simply don't engage). Default 'pay_first' — no venue
// changes behaviour without choosing it in Settings.
async function qrPayLater() {
  try {
    const s = await loadSettings();
    return String(s.qr_payment_policy ?? 'pay_first') === 'pay_later';
  } catch { return false; }
}

async function qrStripeReady() {
  try {
    const s = await loadSettings();
    // AUDIT-002 LOW — '0' is a TRUTHY string, so `a || b` short-circuited on a
    // stored takeaway_mock_pay='0' and qr_mock_pay was never read.
    if (String(s.takeaway_mock_pay ?? '') === '1' || String(s.qr_mock_pay ?? '') === '1') return false;
  } catch { /* settings unreadable → fall through to key check */ }
  if (siampayCfg()) return true;
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
}

// The printable sticker sheet — one card per (non-takeaway) table. Server-
// rendered HTML with inline SVG QRs (qrcode package), opened from the Table
// Plan editor and printed straight from the browser.
// ── SEPOS-MENU-PHOTO-001 — owner-uploaded dish photos ───────────────────────
// Korakot 2026-08-07: "will client able to put the photo by them self?" — they
// couldn't: image_url existed in the DB and the API, but the Admin menu editor
// had no field, so photos were something WE loaded at onboarding. A restaurant
// changes dishes and specials constantly, and the self-order/QR pages are
// exactly where a photo earns its money, so the owner must own this.
//
// The bytes live in menu_item_images and are served from here, NOT inlined into
// /api/menu — a 95-dish menu with embedded base64 would be an 11 MB download on
// a customer's phone. The client resizes before upload (max ~900px JPEG), so a
// dish photo is ~100-150 KB.
app.post('/api/menu/items/:id/image', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  // Verify pass (HIGH) — a photo uploaded on a Pro (local) till used to stay in
  // that till's SQLite. The customer-facing menu is served by the CLOUD, so the
  // photo never reached a single customer, and the till then pushed an
  // image_url pointing at a route the cloud had no bytes for — a 404 on every
  // dish card. Forward the upload like every other config write.
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const raw = String(req.body?.data || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!m) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP image' });
    const bytes = Math.floor((m[2].length * 3) / 4);
    if (bytes > 3 * 1024 * 1024) return res.status(413).json({ error: 'Photo is too large — please use a smaller one' });
    const itemRes = await pool.query('SELECT id FROM menu_items WHERE id = $1', [req.params.id]);
    if (!itemRes.rows[0]) return res.status(404).json({ error: 'Dish not found' });
    await pool.query('DELETE FROM menu_item_images WHERE menu_item_id = $1', [req.params.id]);
    await pool.query('INSERT INTO menu_item_images (menu_item_id, mime, data) VALUES ($1,$2,$3)',
      [req.params.id, m[1], m[2]]);
    // Cache-buster in the URL so a replaced photo shows up immediately on
    // phones that already cached the old one.
    const url = `/api/menu/items/${req.params.id}/image?v=${Date.now()}`;
    await pool.query('UPDATE menu_items SET image_url = $1 WHERE id = $2', [url, req.params.id]);
    res.json({ success: true, image_url: url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/menu/items/:id/image', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    await pool.query('DELETE FROM menu_item_images WHERE menu_item_id = $1', [req.params.id]);
    await pool.query('UPDATE menu_items SET image_url = NULL WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public — this is what a customer's phone actually loads. Immutable per ?v=,
// so it is cached hard and costs nothing on repeat views.
app.get('/api/menu/items/:id/image', widgetCors, async (req, res) => {
  try {
    const r = await pool.query('SELECT mime, data FROM menu_item_images WHERE menu_item_id = $1', [req.params.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).end();
    const buf = Buffer.from(row.data, 'base64');
    res.set('Content-Type', row.mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (err) { res.status(500).end(); }
});

app.get('/api/qr/sheet', async (req, res) => {
  try {
    if (!await qrEnabled()) {
      return res.status(403).type('text/html').send('<h3 style="font-family:sans-serif">QR ordering is switched off — enable it in Settings first (qr_ordering_enabled).</h3>');
    }
    const QRCode = require('qrcode');
    // The QR must carry a CUSTOMER-reachable address. On a desktop till the
    // request host is localhost:3001 — meaningless on a customer's phone —
    // so prefer the install's cloud URL (tokens verify identically there:
    // same SYNC_SECRET, same table ids). Cloud deployments fall through to
    // their own host as before.
    const base = (process.env.PUBLIC_API_URL || process.env.CLOUD_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    // SEPOS-BRAND-001 precedence — company_name is the OWNER-edited field and
    // must win over the legacy restaurant_name (Korakot renamed in Settings,
    // sheet kept showing the old demo name).
    const nameRes = await pool.query(`SELECT value FROM settings WHERE key IN ('restaurant_name','company_name') AND COALESCE(value,'') <> '' ORDER BY key = 'company_name' DESC LIMIT 1`);
    const rName = nameRes.rows[0]?.value || 'SiamEPOS';
    const tRes = await pool.query(`SELECT id, table_number, name FROM tables WHERE COALESCE(is_takeaway,0) = 0 ORDER BY table_number`);
    // SEPOS-QR-SHEET-ORDER — Korakot, 2026-08-07: sorting by the internal
    // table_number interleaved the sheet ("Bar 1, Table 1, Bar 2, Table 2,
    // Table 3…, Bar 3…"), because "Bar 2" IS table_number 2. You print this,
    // cut it up and laminate it, so it has to come out grouped and counting
    // up. Natural sort: group by the name's text prefix, then by its trailing
    // number numerically (so Bar 10 follows Bar 9, not Bar 1). Unnamed tables
    // fall back to their number.
    const sortKey = (t) => {
      const label = (t.name && String(t.name).trim()) ? String(t.name).trim() : `Table ${t.table_number}`;
      const m = /^(.*?)(\d+)\s*$/.exec(label);
      return {
        prefix: (m ? m[1] : label).trim().toLowerCase(),
        num: m ? Number(m[2]) : Number.MAX_SAFE_INTEGER,
        label,
      };
    };
    const sorted = tRes.rows.map(t => ({ t, k: sortKey(t) })).sort((a, b) =>
      a.k.prefix.localeCompare(b.k.prefix) || a.k.num - b.k.num || a.k.label.localeCompare(b.k.label)
    ).map(x => x.t);
    const cards = [];
    for (const t of sorted) {
      const label = (t.name && String(t.name).trim()) ? t.name : `Table ${t.table_number}`;
      const url = `${base}/qr/t/${qrToken(t.id)}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
      cards.push(`<div class="card"><div class="qr">${svg}</div><div class="tname">${String(label).replace(/</g, '&lt;')}</div><div class="hint">Scan to view the menu &amp; order</div></div>`);
    }
    res.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${String(rName).replace(/</g, '&lt;')} — table QR codes</title><style>
      body{font-family:-apple-system,system-ui,sans-serif;margin:24px}
      h1{font-size:18px} .muted{color:#777;font-size:13px;margin-bottom:18px}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
      .card{border:2px solid #1a1a2e;border-radius:14px;padding:16px;text-align:center;page-break-inside:avoid}
      .qr svg{width:100%;max-width:220px;height:auto}
      .tname{font-size:22px;font-weight:800;margin-top:8px}
      .hint{font-size:12px;color:#555;margin-top:2px}
      @media print{.noprint{display:none}}
    </style></head><body>
      <div class="noprint"><h1>${String(rName).replace(/</g, '&lt;')} — table QR codes</h1>
      <div class="muted">Print, laminate, one per table. Codes are permanent — renaming or moving a table never breaks its sticker. Reprint this page after adding tables.</div>
      <button onclick="window.print()" style="padding:10px 18px;font-size:15px;font-weight:700;border-radius:10px;border:none;background:#1a1a2e;color:#fff;cursor:pointer;margin-bottom:18px">🖨 Print</button></div>
      <div class="grid">${cards.join('')}</div></body></html>`);
  } catch (err) {
    console.error('[qr] sheet', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SEPOS-QR-RECEIPT-001 — a receipt for the customer who wants one ─────────
// Korakot 2026-08-07: "the self-order need a receipt for those who need it."
// A QR customer pays on their own phone and never touches the till, so there
// is no paper unless staff print one. This renders their own receipt from the
// order the token owns — VAT-registered restaurants must be able to give one,
// and people claiming expenses need it. Token-scoped: it can only ever show
// the order sitting on THAT table, never anyone else's bill.
app.get('/api/qr/receipt/:token', widgetCors, async (req, res) => {
  try {
    if (!await qrEnabled()) return res.status(403).json({ error: 'QR ordering is not enabled' });
    const tableId = qrVerifyToken(req.params.token);
    if (!tableId) return res.status(404).json({ error: 'This code is no longer active' });
    const orderId = Number(req.query.order_id) || null;
    const payId = Number(req.query.payment_id) || null;
    // The order must belong to this table — a guessed id from another table
    // must not render someone else's bill.
    // Verify pass — three faults fixed here:
    //  · the receipt used to vanish the moment the order closed, which is
    //    exactly when a customer asks for one (no status filter now);
    //  · it looked up the table's NEWEST order, so a later party's bill could
    //    surface, or a £0 receipt when the newest wasn't the QR one;
    //  · with a payment_id we can find the order that tender belongs to
    //    directly, which is always the right one.
    const oRes = await pool.query(
      payId
        ? `SELECT o.*, t.name AS table_label, t.is_takeaway AS table_is_takeaway, t.table_number
             FROM orders o LEFT JOIN tables t ON t.id = o.table_id
            WHERE o.table_id = $1 AND o.source = 'qr'
              AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.id = $2)
            LIMIT 1`
        : `SELECT o.*, t.name AS table_label, t.is_takeaway AS table_is_takeaway, t.table_number
             FROM orders o LEFT JOIN tables t ON t.id = o.table_id
            WHERE o.table_id = $1 AND o.source = 'qr'
              ${orderId ? 'AND o.id = $2' : ''}
            ORDER BY o.id DESC LIMIT 1`,
      payId ? [tableId, payId] : (orderId ? [tableId, orderId] : [tableId]));
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'No order found for this table' });
    // SEPOS-QR-RECEIPT-001 — a receipt for the PAYMENT, not the table. Pass
    // ?payment_id= (the phone gets it back when it pays) and you get exactly
    // what that person ordered and paid — correct on a shared table where four
    // people each paid their own round. Without it, the whole order is shown,
    // which is what staff want and what a single-payer table should see.
    const [items, pays, sRes] = await Promise.all([
      pool.query(`SELECT oi.quantity, oi.unit_price, oi.notes, COALESCE(mi.name, oi.item_name) AS name, COALESCE(mi.vat_rate, 20) AS vat_rate
                    FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
                   WHERE oi.order_id = $1 AND oi.voided = 0 ${payId ? 'AND oi.payment_id = $2' : ''} ORDER BY oi.id`,
                 payId ? [order.id, payId] : [order.id]),
      pool.query(`SELECT id, amount, method, created_at FROM payments WHERE order_id = $1 ${payId ? 'AND id = $2' : ''} ORDER BY id`,
                 payId ? [order.id, payId] : [order.id]),
      pool.query(`SELECT key, value FROM settings WHERE key IN ('company_name','restaurant_name','company_address','company_phone','company_vat','currency_symbol','vat_mode','brand_primary')`),
    ]);
    const cfg = {}; for (const r of sRes.rows) cfg[r.key] = r.value;
    res.json({
      order_id: order.id,
      table: (order.table_label && String(order.table_label).trim()) || `Table ${order.table_number}`,
      opened_at: order.opened_at, closed_at: order.closed_at, status: order.status,
      items: items.rows, payments: pays.rows,
      scoped_to_payment: !!payId,
      // Scoped receipt = what THIS person paid; unscoped = the table's total.
      total: payId
        ? Number(pays.rows.reduce((a, p) => a + Number(p.amount || 0), 0).toFixed(2))
        : Number(order.total || 0),
      restaurant: {
        name: (cfg.company_name !== undefined && cfg.company_name !== null)
          ? String(cfg.company_name).trim() : (String(cfg.restaurant_name || '').trim() || 'Restaurant'),
        address: cfg.company_address || '', phone: cfg.company_phone || '',
        vat: cfg.company_vat || '', currency: cfg.currency_symbol || '£',
        vat_mode: cfg.vat_mode || 'inclusive', brand: cfg.brand_primary || '#1E4038',
      },
    });
  } catch (err) {
    console.error('[qr] receipt', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Email the same receipt. Customer-entered address only — nothing is stored
// against them and no marketing consent is implied by asking for a receipt.
app.post('/api/qr/receipt/:token/email', widgetCors, async (req, res) => {
  try {
    if (!await qrEnabled()) return res.status(403).json({ error: 'QR ordering is not enabled' });
    const tableId = qrVerifyToken(req.params.token);
    if (!tableId) return res.status(404).json({ error: 'This code is no longer active' });
    const to = String(req.body?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Please enter a valid email address' });
    const orderId = Number(req.body?.order_id) || null;
    const payId = Number(req.body?.payment_id) || null;
    const oRes = await pool.query(
      `SELECT o.*, t.name AS table_label, t.is_takeaway AS table_is_takeaway, t.table_number FROM orders o LEFT JOIN tables t ON t.id = o.table_id
        WHERE o.table_id = $1 AND o.source = 'qr' ${orderId ? 'AND o.id = $2' : ''} ORDER BY o.id DESC LIMIT 1`,
      orderId ? [tableId, orderId] : [tableId]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'No order found for this table' });
    const [items, pays, sRes] = await Promise.all([
      pool.query(`SELECT oi.quantity, oi.unit_price, oi.notes, COALESCE(mi.name, oi.item_name) AS name
                    FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
                   WHERE oi.order_id = $1 AND oi.voided = 0 ${payId ? 'AND oi.payment_id = $2' : ''} ORDER BY oi.id`,
                 payId ? [order.id, payId] : [order.id]),
      pool.query(`SELECT amount, method FROM payments WHERE order_id = $1 ${payId ? 'AND id = $2' : ''} ORDER BY id`,
                 payId ? [order.id, payId] : [order.id]),
      pool.query(`SELECT key, value FROM settings WHERE key IN ('company_name','restaurant_name','company_address','company_phone','company_vat','currency_symbol','brand_primary')`),
    ]);
    const cfg = {}; for (const r of sRes.rows) cfg[r.key] = r.value;
    const cur = cfg.currency_symbol || '£';
    const name = (cfg.company_name !== undefined && cfg.company_name !== null)
      ? String(cfg.company_name).trim() : (String(cfg.restaurant_name || '').trim() || 'Restaurant');
    const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const rows = items.rows.map(i =>
      `<tr><td style="padding:6px 0">${i.quantity} × ${esc(i.name)}${i.notes ? `<div style="font-size:12px;color:#777">${esc(i.notes)}</div>` : ''}</td>` +
      `<td style="padding:6px 0;text-align:right">${cur}${(Number(i.unit_price) * Number(i.quantity)).toFixed(2)}</td></tr>`).join('');
    const paid = pays.rows.map(p => `<tr><td style="padding:3px 0;color:#555">${esc(p.method)}</td><td style="padding:3px 0;text-align:right">${cur}${Number(p.amount).toFixed(2)}</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:22px">
      <h2 style="margin:0 0 2px;color:${esc(cfg.brand_primary || '#1E4038')}">${esc(name)}</h2>
      ${cfg.company_address ? `<div style="font-size:13px;color:#666">${esc(cfg.company_address)}</div>` : ''}
      ${cfg.company_phone ? `<div style="font-size:13px;color:#666">Tel: ${esc(cfg.company_phone)}</div>` : ''}
      ${cfg.company_vat ? `<div style="font-size:13px;color:#666">VAT No: ${esc(cfg.company_vat)}</div>` : ''}
      <hr style="border:none;border-top:1px solid #eee;margin:14px 0">
      <div style="font-size:13px;color:#666">Order #${order.id} · ${esc((order.table_label && String(order.table_label).trim()) || 'Table ' + order.table_number)}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:14px">${rows}</table>
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
      <table style="width:100%;border-collapse:collapse;font-size:15px;font-weight:700">
        <tr><td style="padding:4px 0">Total</td><td style="padding:4px 0;text-align:right">${cur}${(payId ? pays.rows.reduce((a, p) => a + Number(p.amount || 0), 0) : Number(order.total || 0)).toFixed(2)}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:6px">${paid}</table>
      <p style="font-size:12px;color:#999;margin-top:20px">Thank you — we hope to see you again.</p>
    </div>`;
    const { sendBrevoEmail } = require('./services/emailService');
    await sendBrevoEmail(to, `Your receipt from ${name} — order #${order.id}`, html);
    res.json({ success: true });
  } catch (err) {
    console.error('[qr] receipt email', err.message);
    res.status(500).json({ error: 'Could not send the receipt — please ask a member of staff.' });
  }
});

// The customer's landing page (static shell; JS drives everything).
app.get('/qr/t/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'qr-order.html'));
});

// SEPOS-ORDER-PAGE-001 — standalone takeaway ordering page in the QR page's
// style (photos, option sheets, kitchen messages). Client websites link a
// button here instead of embedding the legacy takeaway widget; talks to the
// existing hardened /api/takeaway/* endpoints (server pricing, Stripe/mock).
app.get('/order', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'order.html'));
});

// Session bootstrap for the order page: table identity + restaurant + payment
// availability + the table's open QR/dine-in order (running bill + statuses).
app.get('/api/qr/session/:token', widgetCors, async (req, res) => {
  try {
    if (!await qrEnabled()) return res.status(403).json({ error: 'QR ordering is not enabled' });
    const tableId = qrVerifyToken(req.params.token);
    if (!tableId) return res.status(404).json({ error: 'This code is no longer active — please ask a member of staff.' });
    const tRes = await pool.query(`SELECT id, table_number, name FROM tables WHERE id = $1`, [tableId]);
    const t = tRes.rows[0];
    if (!t) return res.status(404).json({ error: 'This code is no longer active — please ask a member of staff.' });
    const sRes = await pool.query(`SELECT key, value FROM settings WHERE key IN ('restaurant_name','company_name','currency_symbol','brand_primary')`);
    const cfg = {}; for (const r of sRes.rows) cfg[r.key] = r.value;
    const stripeReady = await qrStripeReady();
    // Open order on this table (any dine-in — the customer may be topping up
    // an order a waiter started, that's fine; the bill is the table's bill).
    // Verify pass (HIGH) — the customer's phone must see THEIR QR order, not
    // whatever dine-in bill is newest on the table. Without source='qr' a
    // waiter's separate bill surfaced here and the guest's own order + receipt
    // vanished.
    const oRes = await pool.query(
      `SELECT id, total, payment_status, source FROM orders
        WHERE table_id = $1 AND status = 'open' AND source = 'qr'
        ORDER BY id DESC LIMIT 1`, [tableId]);
    let order = null;
    if (oRes.rows[0]) {
      const items = await pool.query(
        `SELECT oi.id, oi.quantity, oi.unit_price, oi.status, oi.item_note, oi.notes, oi.voided,
                COALESCE(mi.name, oi.item_name) AS name
           FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
          WHERE oi.order_id = $1 AND oi.voided = 0 ORDER BY oi.id`, [oRes.rows[0].id]);
      order = { ...oRes.rows[0], items: items.rows };
    }
    res.json({
      restaurant_name: cfg.company_name || cfg.restaurant_name || 'Restaurant',
      currency: cfg.currency_symbol || '£',
      brand: cfg.brand_primary || '#1E4038',
      table: { id: t.id, label: (t.name && String(t.name).trim()) ? t.name : `Table ${t.table_number}` },
      stripe_ready: stripeReady,
      pay_later: await qrPayLater(),   // SEPOS-QR-PAYLATER-001
      order,
    });
  } catch (err) {
    console.error('[qr] session', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Place a round: server-prices every line, verifies the payment against that
// total (when Stripe is live), then creates/appends the table's order with
// everything fired to the kitchen at once. Mock mode (no keys) skips the
// payment but marks the order payment_status='mock' so the demo flow is
// end-to-end identical.
app.post('/api/qr/orders/:token', widgetCors, requireActiveSubscription, requireValidLicense, async (req, res) => {
  try {
    if (!await qrEnabled()) return res.status(403).json({ error: 'QR ordering is not enabled' });
    const tableId = qrVerifyToken(req.params.token);
    if (!tableId) return res.status(404).json({ error: 'This code is no longer active — please ask a member of staff.' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
    if (items.length > 40) return res.status(400).json({ error: 'Too many items in one order' });

    // SEPOS-QR-HOURS-001 (Korakot, 28 Aug — "if the customer takes the link
    // home, nothing can deny them?"): the sticker's link works from anywhere
    // and pay-later removed the prepayment shield, so QR ordering is gated to
    // the venue's service hours — the same guard the takeaway widget has had
    // since SEPOS-TA-HOURS-001, with the same fail-CLOSED defaults (no hours
    // row → 11:00–21:30 Europe/London). Applies to pay-first too: an order
    // fired at 3am helps nobody whoever paid for it.
    {
      const hrsRes = await pool.query(
        `SELECT service_type, opening_time, last_booking_time,
                lunch_service_start, lunch_service_end,
                dinner_service_start, dinner_service_end, timezone
           FROM restaurant_settings WHERE restaurant_id = $1`,
        [resolveRestaurantId(req)]);
      const hrs = hrsRes.rows[0] || {};
      const tz = hrs.timezone || 'Europe/London';
      const nowMins = minutesInZone(new Date(), tz);
      const inWindow = (start, end) => {
        const s = toMins(start); const e = toMins(end);
        if (e >= s) return nowMins >= s && nowMins <= e;
        return nowMins >= s || nowMins <= e;   // window wraps past midnight
      };
      const open = hrs.service_type === 'split'
        ? (inWindow(hrs.lunch_service_start || '11:00', hrs.lunch_service_end || '14:30')
           || inWindow(hrs.dinner_service_start || '17:30', hrs.dinner_service_end || '21:30'))
        : inWindow(hrs.opening_time || '11:00', hrs.last_booking_time || '21:30');
      if (!open) return res.status(409).json({ error: 'Ordering is closed right now — please order during opening hours, or ask a member of staff.' });
    }
    await ensureOpenSession(resolveRestaurantId(req)); // SEPOS-AUTO-SESSION-001

    // Server-side pricing — the client's numbers are display only. Chosen
    // modifiers are re-looked-up by id: name + surcharge come from OUR rows
    // (anti-tamper), then ride the same `notes` text convention the waiter
    // flow uses so kitchen tickets print them identically.
    const priced = [];
    let totalPence = 0;
    for (const it of items) {
      const qty = Math.max(1, Math.min(20, Number(it.quantity) || 1));
      const row = (await pool.query(`SELECT id, name, price, is_available, COALESCE(is_online,1) AS is_online FROM menu_items WHERE id = $1`, [it.menu_item_id])).rows[0];
      if (!row) return res.status(400).json({ error: 'An item in your cart is no longer on the menu — please refresh.' });
      if (!Number(row.is_available) || !Number(row.is_online)) {
        return res.status(409).json({ error: `Sorry — "${row.name}" has just sold out. Please remove it and try again.` });
      }
      let unit = Number(row.price) || 0;
      const modNames = [];
      const modIds = Array.isArray(it.modifiers) ? it.modifiers.slice(0, 12) : [];
      for (const mid of modIds) {
        const mr = (await pool.query(`SELECT name, extra_price FROM modifiers WHERE id = $1 AND is_available = 1`, [Number(mid)])).rows[0];
        if (!mr) return res.status(409).json({ error: 'An option in your cart is no longer available — please re-add the dish.' });
        unit += Number(mr.extra_price) || 0;
        modNames.push(mr.name);
      }
      totalPence += Math.round(unit * 100) * qty;
      priced.push({ menu_item_id: row.id, quantity: qty, unit_price: unit,
        notes: modNames.join(', ').slice(0, 300),
        item_note: String(it.item_note || '').slice(0, 200) });
    }
    if (totalPence <= 0) return res.status(400).json({ error: 'Order total is zero — please ask staff to order these items.' });

    // Pay-first verification (identical hardening to the takeaway widget).
    const sp = siampayCfg();
    // SEPOS-QR-PAYLATER-001 — venue policy beats key presence: in pay-later
    // mode no payment is required OR recorded here; the order lands 'unpaid'
    // and staff tender it at the till like any bill (same machinery as
    // pay-on-collection takeaway).
    const payLater = await qrPayLater();
    const stripeReady = !payLater && await qrStripeReady();
    let paymentStatus = payLater ? 'unpaid' : 'mock';
    let paidPence = null;
    let verifiedPiId = null;
    if (stripeReady) {
      const piId = req.body?.payment_intent_id;
      if (!piId) return res.status(402).json({ error: 'Payment required' });
      try {
        const pi = sp
          ? await require('stripe')(sp.key).paymentIntents.retrieve(piId, {}, { stripeAccount: sp.account })
          : await require('stripe')(process.env.STRIPE_SECRET_KEY).paymentIntents.retrieve(piId);
        if (pi.status !== 'succeeded') return res.status(402).json({ error: `Payment not completed (${pi.status})` });
        if (pi.currency !== 'gbp') return res.status(402).json({ error: 'Payment currency mismatch' });
        if (pi.amount !== totalPence) return res.status(402).json({ error: 'Payment amount mismatch — please refresh and try again.' });
        if (pi.metadata?.product !== 'siamepos_qr_order') return res.status(402).json({ error: 'Payment reference mismatch' });
        // A PI is minted for ONE table (metadata.table_id, set at mint time).
        // Without this check a token-holder could pay once at their own table
        // and replay that payment to fire food at any other table.
        if (String(pi.metadata?.table_id || '') !== String(tableId)) {
          return res.status(402).json({ error: 'That payment was for a different table — please start again from your table\'s QR code.' });
        }
        paymentStatus = 'paid';
        paidPence = pi.amount;
        verifiedPiId = pi.id;
      } catch (e) {
        console.error('[qr] stripe verify', e.message);
        return res.status(402).json({ error: 'Could not verify payment — please try again.' });
      }
      // REPLAY GUARD — one succeeded PI settles exactly one round. Checked
      // here (fast, friendly), again inside the per-table lock, and backstopped
      // by a unique index. Without it a single £20 charge could be replayed to
      // fire unlimited rounds of food.
      const seen = await pool.query('SELECT order_id FROM payments WHERE payment_intent_id = $1 LIMIT 1', [verifiedPiId]);
      if (seen.rows[0]) {
        return res.status(409).json({ error: 'This payment has already been used for an order — you have not been charged again.' });
      }
    }

    // Create-or-append under the same per-table lock the waiter flow uses.
    let roundPaymentId = null;
    // Pay-FIRST means the card is confirmed on the customer's phone BEFORE any
    // of this runs, so a failure past this point is money taken with no food
    // ordered. Refund it rather than leaving the customer to notice and chase.
    // A replay is excluded — that PI legitimately paid for an order already.
    const out = await runExclusiveWithRefund(verifiedPiId, sp, `order-create:table:${tableId}`, async () => {
      // SEPOS-QR-PAY-REDO — a QR round may ONLY join an order this flow created
      // itself. Adopting a waiter's open bill was the root of the whole
      // partial-payment mess: a customer paying £5 for a dessert stamped the
      // waiter's £40 table as paid, and the serve-time auto-close then closed
      // it and lost the £40. With `source='qr'` in the WHERE clause every QR
      // order is fully paid by construction, so 'part_paid' never has to exist
      // and the auto-close needs no reconciliation. A table can now hold a
      // waiter's bill AND a QR bill at once — which is honest, because two
      // separate payments really did happen.
      // SEPOS-QR-PAYLATER-001 — a round may only join an order of ITS OWN
      // payment mode. A pay-later round appending onto a prepaid order would
      // overwrite payment_status and strip the read-only protection off money
      // already taken (and a prepaid round landing on an unpaid order would
      // stamp 'paid' over rounds nobody paid for). Mode-mismatch → new order;
      // a table honestly holding both is the same rule as waiter + QR bills.
      const existing = await pool.query(
        `SELECT o.id FROM orders o
          WHERE o.table_id = $1 AND o.status = 'open' AND o.source = 'qr'
            AND (o.order_type IS NULL OR o.order_type = 'dine_in')
            AND COALESCE(o.payment_status,'') ${payLater ? `= 'unpaid'` : `IN ('paid','mock')`}
          ORDER BY o.id DESC LIMIT 1`, [tableId]);
      // Re-check inside the lock: two concurrent replays of the same PI would
      // both have passed the friendly pre-check above.
      if (verifiedPiId) {
        const dup = await pool.query('SELECT order_id FROM payments WHERE payment_intent_id = $1 LIMIT 1', [verifiedPiId]);
        if (dup.rows[0]) { const e = new Error('payment_replayed'); e.qrReplay = true; throw e; }
      }
      let orderId;
      if (existing.rows[0]) {
        orderId = existing.rows[0].id;
      } else {
        const ins = await pool.query(
          `INSERT INTO orders (table_id, status, covers, order_type, opened_at, source, payment_status, no_service_charge)
           VALUES ($1, 'open', 1, 'dine_in', NOW(), 'qr', $2, 1) RETURNING id`,
          [tableId, paymentStatus]);
        orderId = ins.rows[0].id;
        await offlineQueue.enqueue('create_order', { localOrderId: orderId, table_id: tableId, covers: 1, staff_id: null, order_type: 'dine_in' });
      }
      await pool.query(`UPDATE tables SET status = 'occupied' WHERE id = $1`, [tableId]);
      // Every QR line fires immediately — the customer pressing "Send" IS the
      // fire. Stock depletes now, kitchen sees it now.
      const now = new Date().toISOString();
      const firedIds = [];
      for (const p of priced) {
        const ins = await pool.query(
          `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, status, cooking_started_at)
           VALUES ($1,$2,$3,$4,$5,1,$6,1,$7,'cooking',$8) RETURNING id`,
          [orderId, p.menu_item_id, p.quantity, p.unit_price, p.notes || '', p.item_note, now, now]);
        firedIds.push(ins.rows[0].id);
      }
      const totalRes = await pool.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id = $1 AND voided = 0`, [orderId]);
      await pool.query(`UPDATE orders SET total = $1, source = COALESCE(source,'qr'), payment_status = $2 WHERE id = $3`,
        [totalRes.rows[0].total || 0, paymentStatus, orderId]);
      // Record this round's tender NOW (pay-first) — the auto-close on
      // full service finds the bill already settled.
      // SEPOS-QR-RECEIPT-001 — pay-FIRST means this tender pays for exactly the
      // items in THIS round, so link them. That is what makes a correct receipt
      // possible on a shared table: four friends each paying their own round
      // each get a receipt for what they actually paid, and none of them sees a
      // total nobody paid.
      // SEPOS-QR-PAYLATER-001 — an unpaid round has NO tender to record;
      // staff's payment at the till writes the real one. Recording a phantom
      // row here would double-count the bill the moment staff settle it.
      if (paymentStatus !== 'unpaid') {
        const payIns = await pool.query(
          `INSERT INTO payments (order_id, amount, method, payment_intent_id) VALUES ($1,$2,$3,$4) RETURNING id`,
          [orderId, (paidPence != null ? paidPence / 100 : totalPence / 100),
           paymentStatus === 'paid' ? 'QR Online' : 'QR Online (mock)', verifiedPiId]);
        roundPaymentId = payIns.rows[0].id;
        if (firedIds.length) {
          await pool.query(`UPDATE order_items SET payment_id = $1 WHERE id = ANY($2::int[])`, [roundPaymentId, firedIds]);
        }
      }
      await offlineQueue.enqueue('add_items', { localOrderId: Number(orderId), items: priced.map(p => ({ ...p, is_bar: 0 })) });
      await depleteStockForItems(firedIds, 'sale');
      return { orderId, firedIds, paymentId: roundPaymentId };
    });

    const orderRes = await pool.query(`SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [out.orderId]);
    const newItemsRes = await pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.id = ANY($1::int[])`, [out.firedIds]);
    io.emit('new_order_items', { order: orderRes.rows[0], items: newItemsRes.rows });
    res.json({ success: true, order_id: out.orderId, payment_status: paymentStatus, payment_id: out.paymentId });
  } catch (err) {
    if (err && (err.qrReplay || /idx_payments_payment_intent|payments_payment_intent/i.test(err.message || ''))) {
      console.warn('[qr] replayed payment_intent rejected');
      return res.status(409).json({ error: 'This payment has already been used for an order — you have not been charged again.' });
    }
    console.error('[qr] place order', err);
    if (err && err.qrRefunded) {
      return res.status(500).json({ error: 'Sorry — your order could not be sent to the kitchen, so your payment has been refunded. Please tell a member of staff.', refunded: true });
    }
    if (err && err.qrRefundFailed) {
      return res.status(500).json({ error: 'Sorry — your order could not be sent to the kitchen. Please show this to a member of staff so they can refund you.', refund_failed: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// Payment intent for the QR page — amount is computed SERVER-side from the
// cart (not taken from the client like the takeaway widget's endpoint), so a
// tampered page can't underpay: the same pricing pass runs here and at order
// time, and the order endpoint additionally requires pi.amount === total.
// SEPOS-QR-PAY-REDO — the licence/subscription gates belong HERE too. This flow
// is pay-FIRST, so gating only order creation let a lapsed tenant take the
// customer's money and then refuse the order. Fail before the card is charged.
app.post('/api/qr/payment-intent/:token', widgetCors, requireActiveSubscription, requireValidLicense, async (req, res) => {
  try {
    if (!await qrEnabled()) return res.status(403).json({ error: 'QR ordering is not enabled' });
    const tableId = qrVerifyToken(req.params.token);
    if (!tableId) return res.status(404).json({ error: 'Invalid code' });
    if (!await qrStripeReady()) return res.status(503).json({ error: 'Card payments not configured' });
    const sp = siampayCfg();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.length > 40) return res.status(400).json({ error: 'Invalid cart' });
    let totalPence = 0;
    for (const it of items) {
      const qty = Math.max(1, Math.min(20, Number(it.quantity) || 1));
      const row = (await pool.query(`SELECT price, is_available FROM menu_items WHERE id = $1`, [it.menu_item_id])).rows[0];
      if (!row || !Number(row.is_available)) return res.status(409).json({ error: 'An item just sold out — please refresh your cart.' });
      let unit = Number(row.price) || 0;
      for (const mid of (Array.isArray(it.modifiers) ? it.modifiers.slice(0, 12) : [])) {
        const mr = (await pool.query(`SELECT extra_price FROM modifiers WHERE id = $1 AND is_available = 1`, [Number(mid)])).rows[0];
        if (!mr) return res.status(409).json({ error: 'An option just became unavailable — please re-add the dish.' });
        unit += Number(mr.extra_price) || 0;
      }
      totalPence += Math.round(unit * 100) * qty;
    }
    if (totalPence < 50) return res.status(400).json({ error: 'Minimum card payment is 50p' });
    if (totalPence > 100000) return res.status(400).json({ error: 'Order too large — please ask staff' });
    const params = {
      amount: totalPence, currency: 'gbp',
      description: `QR order — table ${tableId}`,
      automatic_payment_methods: { enabled: true },
      metadata: { product: 'siamepos_qr_order', restaurant_id: resolveRestaurantId(req), table_id: String(tableId) },
    };
    let pi;
    if (sp) {
      params.application_fee_amount = sp.feePence;
      pi = await require('stripe')(sp.key).paymentIntents.create(params, { stripeAccount: sp.account });
    } else {
      pi = await require('stripe')(process.env.STRIPE_SECRET_KEY).paymentIntents.create(params);
    }
    res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id, amount_pence: totalPence });
  } catch (err) {
    console.error('[qr] payment-intent', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SIAMPAY-QR-001 — dine-in QR pay-by-link (Nick's addendum, 21 Jul) ─────
// Waiter rings up the bill → the till requests a Stripe Checkout session →
// shows the QR → customer scans and pays with Apple Pay / Google Pay / card
// → the till polls status and closes the bill through the normal pay flow
// (method 'QR Card' — buckets as 'Other' on Z, correct because the money
// arrives via Stripe payout, not the card machine).
//
// Rails: same decision as everywhere else — tenant's own STRIPE_SECRET_KEY,
// else SiamPay platform mode (direct charge on the connected account + flat
// app fee via payment_intent_data). Stripe-HOSTED Checkout is what makes
// Apple/Google Pay appear with zero domain setup — checkout.stripe.com is
// pre-registered, so scan-to-pay is one tap on any modern phone.
function qrPayRail() {
  const sp = siampayCfg();
  if (sp) return { key: sp.key, opts: { stripeAccount: sp.account }, feePence: sp.feePence };
  if (process.env.STRIPE_SECRET_KEY) return { key: process.env.STRIPE_SECRET_KEY, opts: {}, feePence: 0 };
  return null;
}

app.post('/api/orders/:id/qr-pay', requireActiveSubscription, requireValidLicense, async (req, res) => {  // F31
  const rail = qrPayRail();
  if (!rail) return res.status(503).json({ error: 'No card rail configured — set up SiamPay (or Stripe keys) to use QR pay' });
  const amountPence = Math.round(Number(req.body?.amount) * 100);
  if (!Number.isInteger(amountPence) || amountPence < 30) {
    return res.status(400).json({ error: 'Invalid amount (minimum 30p)' });
  }
  if (amountPence > 500000) {
    return res.status(400).json({ error: 'Amount too large for QR pay' });
  }
  try {
    const ord = await pool.query(
      `SELECT o.id, o.status, t.name AS table_name, t.table_number
         FROM orders o LEFT JOIN tables t ON t.id = o.table_id
        WHERE o.id = $1`, [req.params.id]);
    const order = ord.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'open') return res.status(409).json({ error: `This bill is already ${order.status}` });
    const tableLabel = order.table_name || (order.table_number != null ? `Table ${order.table_number}` : `Order #${order.id}`);
    const rn = process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant';
    const params = {
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: amountPence,
          product_data: { name: `${rn} — ${tableLabel}` },
        },
      }],
      // Checkout minimum is 30 min; the till's QR modal is the real timeout.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      metadata: { purpose: 'qr_bill', order_id: String(order.id), product: 'siamepos_qr_pay' },
      success_url: `${req.protocol}://${req.get('host')}/qr-pay-thanks`,
      cancel_url:  `${req.protocol}://${req.get('host')}/qr-pay-thanks?status=cancelled`,
    };
    if (rail.feePence > 0) params.payment_intent_data = { application_fee_amount: rail.feePence };
    const session = await require('stripe')(rail.key).checkout.sessions.create(params, rail.opts);
    res.json({ session_id: session.id, url: session.url, amount_pence: amountPence });
  } catch (err) {
    console.error('[qr-pay] create', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:id/qr-pay/status', requireValidLicense, async (req, res) => {
  const rail = qrPayRail();
  if (!rail) return res.status(503).json({ error: 'No card rail configured' });
  const sessionId = String(req.query.session_id || '');
  if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'session_id required' });
  try {
    const sess = await require('stripe')(rail.key).checkout.sessions.retrieve(sessionId, {}, rail.opts);
    // The session must belong to THIS order — stops a paid session for a £5
    // bill being replayed to close someone else's £80 bill.
    if (String(sess.metadata?.order_id) !== String(req.params.id)) {
      return res.status(400).json({ error: 'session does not match this order' });
    }
    res.json({
      paid: sess.payment_status === 'paid',
      status: sess.status,
      amount_total: sess.amount_total,
    });
  } catch (err) {
    console.error('[qr-pay] status', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Tiny customer-facing landing after Checkout — they just show the till.
app.get('/qr-pay-thanks', (req, res) => {
  const cancelled = req.query.status === 'cancelled';
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0D1B3E;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">
<div style="padding:32px"><div style="font-size:64px">${cancelled ? '↩️' : '✅'}</div>
<h1 style="margin:12px 0 8px;font-size:24px">${cancelled ? 'Payment cancelled' : 'Payment received!'}</h1>
<p style="opacity:.8;font-size:16px">${cancelled ? 'No charge was made — please see a member of staff.' : 'Thank you — your server will confirm it on the till. You can close this page.'}</p></div></body>`);
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
    // F8 — card charges under 30p are rejected by Stripe with a raw 500; with
    // the £10 floor gone, guard here like qr-pay does.
    if (Number(req.body?.amount) > 0 && Number(req.body.amount) < 0.30) {
      return res.status(400).json({ error: 'Card payments need a minimum of £0.30' });
    }
    const v = voucherSvc.validateAmount(req.body?.amount);
    if (!v.ok) return res.status(400).json({ error: v.error });
    // Demo tenants force mock pay via the same flag the takeaway widget
    // honours — otherwise a SiamPay/own-keys tenant in TEST mode would show
    // prospects a real card form their own cards can't complete.
    let mock = false;
    try { const s = await loadSettings(); mock = String(s.takeaway_mock_pay || '') === '1'; } catch {}
    const pi = mock
      ? { mode: 'mock',
          payment_intent_id: 'mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          client_secret: 'mock_secret_no_real_payment',
          publishable_key: null }
      : await voucherSvc.createPaymentIntent(v.amount);
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
    // allowMock mirrors the purchase endpoint's demo-flag decision, so a
    // demo tenant's mock voucher confirms but a paying tenant can't be
    // tricked with a hand-crafted "mock_" id.
    let mockOk = false;
    try { const s = await loadSettings(); mockOk = String(s.takeaway_mock_pay || '') === '1'; } catch {}
    const verify = await voucherSvc.verifyPaymentIntent(payment_intent_id, v.amount, { allowMock: mockOk });
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
  // SEPOS-AUDIT-001 — vouchers are CLOUD-authoritative. A local till's SQLite
  // has no voucher rows (they're not in the sync pull), so this lookup used to
  // 404 for every cloud-sold voucher — pushing BillScreen into the external-
  // bypass tender and letting the same voucher redeem at full value forever.
  // Forward to the cloud; fall back to local only when offline.
  if (await forwardToCloudWith(req, res, 'voucher-lookup')) return;
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
  // SEPOS-AUDIT-001 — redeem against the CLOUD balance on local installs
  // (that's where the voucher lives and where FOR UPDATE serialises the
  // decrement). bill_id is a LOCAL order id here — translate it to the cloud
  // id so the redemption links to the right cloud bill (null when unbound;
  // the balance still decrements correctly). Falls back to the local table
  // only when the cloud is unreachable.
  {
    const cloudBillId = req.body?.bill_id ? await localOrderCloudId(req.body.bill_id) : null;
    // Verify pass — forward ONLY when the bill translates (or none was given):
    // forwarding with bill_id:null recorded an ORPHANED redemption on the
    // cloud that voucher-remove could never find (404 → balance unrestorable
    // on an undo). Unbound = the order's create push hasn't landed (seconds) —
    // fall through to the local handler like the offline path.
    if (!req.body?.bill_id || cloudBillId) {
      if (await forwardToCloudWith(req, res, 'voucher-redeem', {
        body: { ...(req.body || {}), bill_id: cloudBillId },
      })) return;
    }
  }
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
  // SEPOS-AUDIT-001 — the redemption we're undoing lives on the CLOUD (redeem
  // is forwarded there on local installs), keyed by the CLOUD bill id.
  // Forward the restore with the translated path; on success also clear the
  // LOCAL order's voucher discount — the pull's null-drop rule would keep it
  // stuck otherwise (cloud sends discount fields as null after clearing).
  {
    const cloudId = await localOrderCloudId(req.params.id);
    if (cloudId) {
      const localId = req.params.id;
      if (await forwardToCloudWith(req, res, 'voucher-remove', {
        path: `/api/orders/${cloudId}/voucher-remove`,
        afterOk: async (j) => {
          if (j && j.voucher_code) {
            await pool.query(
              `UPDATE orders SET discount_type = NULL, discount_value = NULL, discount_reason = NULL
               WHERE id = $1 AND discount_reason LIKE $2`,
              [localId, `Voucher ${j.voucher_code}%`]
            );
            // SEPOS-AUDIT-001 (verify pass) — the clear must travel through
            // the SAME FIFO queue as the voucher's original apply_discount
            // push: if that push is still queued, it would otherwise land on
            // the cloud AFTER the balance was restored and re-instate the
            // discount (bill £N cheaper with no redemption on record).
            await offlineQueue.enqueue('apply_discount', {
              localOrderId: Number(localId),
              discount_type: null, discount_value: null, discount_reason: null,
            });
          }
        },
      })) return;
    }
  }
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
    let clearedDiscount = false;
    if (order.discount_reason && order.discount_reason.startsWith(`Voucher ${vr.code}`)) {
      await client.query(
        `UPDATE orders SET discount_type = NULL, discount_value = NULL, discount_reason = NULL WHERE id = $1`,
        [orderId]
      );
      clearedDiscount = true;
    }

    await client.query('COMMIT');
    // SEPOS-AUDIT-001 (verify pass) — local-fallback path: push the clear
    // through the queue so it lands AFTER any queued voucher apply_discount
    // (no-op on cloud installs).
    if (clearedDiscount) {
      await offlineQueue.enqueue('apply_discount', {
        localOrderId: Number(orderId),
        discount_type: null, discount_value: null, discount_reason: null,
      });
    }
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
app.get('/api/vouchers', requireStaffAuthOrSyncSecret(), async (req, res) => {
  // SEPOS-AUDIT-001 — cloud-authoritative on local installs (see voucher-lookup).
  if (await forwardToCloudWith(req, res, 'voucher-list')) return;
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
  // SEPOS-AUDIT-001 — cloud-authoritative on local installs (ids come from the
  // forwarded list above, so they're cloud ids).
  if (await forwardToCloudWith(req, res, 'voucher-detail')) return;
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
  // SEPOS-AUDIT-001 — cloud-authoritative on local installs.
  if (await forwardToCloudWith(req, res, 'voucher-void')) return;
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
  // SEPOS-AUDIT-001 — sell on the CLOUD from local installs: the voucher then
  // exists where redemptions/lookups are served, the gift email's Add-to-Wallet
  // link (built against the cloud host) actually resolves, and cloud/ops
  // reporting sees the liability. Falls back to a local-only sale when offline
  // (degraded but not lost — same as before this fix).
  if (await forwardToCloudWith(req, res, 'voucher-sell')) return;
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
    // SEPOS-AUDIT-001 (verify pass) — OFFLINE fallback only reaches here on a
    // local install (the forward above returned false = cloud unreachable).
    // Replay the sale to the cloud with the SAME printed code so the
    // customer's voucher works once connectivity returns (without this the
    // code lived only in local SQLite and every later cloud lookup 404'd).
    // No-op on cloud installs (enqueue is inert in cloud mode).
    await offlineQueue.enqueue('sell_voucher', {
      code: voucher.code, original_amount: Number(voucher.original_amount),
      recipient_name: recipient_name || null, recipient_email: recipient_email || null,
      sender_name: sender_name || null, message: message || null,
      delivery_date: delivery_date || null, expires_at: voucher.expires_at,
      payment_method: method, restaurant_id: rid,
    });
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
  // SEPOS-AUDIT-001 — resend from the CLOUD so the emailed wallet/balance
  // links point at a host that actually has the voucher.
  if (await forwardToCloudWith(req, res, 'voucher-resend')) return;
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
  // Review H1 — vouchers/deposits are cloud-authoritative: create on the
  // cloud (like redeem/lookup already do) or a local till mints a deposit
  // the cloud-forwarded redeem can't find (404 in front of the guest).
  if (await forwardToCloudWith(req, res, 'deposit-create')) return;
  try {
    const { amount, payment_method, reservation_id, customer_name, customer_email } = req.body || {};
    // Deposits: any positive amount — the £10 floor is a gift-voucher rule.
    const v = voucherSvc.validateAmount(amount, { minimum: 0.01 });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const method = String(payment_method || 'card').toLowerCase();
    // 'external' = SEPOS-DEPOSIT-EXT-001: a deposit taken OUTSIDE SiamEPOS
    // (old system / phone / paper), recorded here so it can be applied to a
    // bill. Kept as its own method so deposit reports can separate it from
    // money actually taken through the till.
    if (!['cash', 'card', 'mock', 'external'].includes(method)) {
      return res.status(400).json({ error: 'payment_method must be cash, card, mock or external' });
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
    // SEPOS-DEPOSIT-EXT-001b (Korakot, 12 Aug) — an EXTERNAL deposit keeps the
    // CUSTOMER'S OWN reference as its code (the number on their old-system
    // receipt / paper), so next week's lookup matches what's in their hand.
    // Rejected if the reference already exists as any voucher — a typed
    // reference can never hijack or shadow a real SiamEPOS code.
    let requestedCode = String(req.body?.code || '').trim().toUpperCase().slice(0, 20).trim(); // F3: vouchers.code is VARCHAR(20)
    if (requestedCode) {
      if (!/^[A-Z0-9][A-Z0-9 _\/-]*$/.test(requestedCode)) {
        return res.status(400).json({ error: 'Reference can use letters, numbers, spaces and - _ /' });
      }
      // Canary find #11 — references are casual ("T", a daily ticket number),
      // so collisions are NORMAL. Only a LIVE code with money on it is
      // protected; a spent/expired/old reference auto-suffixes silently —
      // staff never solve naming puzzles at the table.
      const clash = await pool.query('SELECT id, status, balance, type FROM vouchers WHERE code = $1', [requestedCode]);
      const row = clash.rows[0];
      if (row && row.status === 'active' && Number(row.balance) > 0) {
        return res.status(409).json({ error: `${requestedCode} is a live SiamEPOS ${row.type === 'deposit' ? 'deposit' : 'voucher'} with £${Number(row.balance).toFixed(2)} on it — look it up and use its real balance.` });
      }
      if (row) {
        for (let n = 2; n <= 99; n++) {
          const cand = `${requestedCode.slice(0, 16)}-${n}`;
          const e2 = await pool.query('SELECT id FROM vouchers WHERE code = $1', [cand]);
          if (!e2.rows[0]) { requestedCode = cand; break; }
        }
      }
    }
    let code = requestedCode || null;
    if (!code) for (let i = 0; i < 10; i++) {
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
  // SEPOS-AUDIT-001 — deposits are vouchers, which are cloud-authoritative on
  // local installs. Translate the LOCAL order id to its cloud id and ask the
  // cloud; fall back to the local table when offline or unbound.
  {
    const cloudId = await localOrderCloudId(req.params.id);
    if (cloudId && await forwardToCloudWith(req, res, 'deposit-lookup', {
      path: `/api/orders/${cloudId}/deposit`,
    })) return;
  }
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

// SEPOS-DEPOSIT-ORDER-001 — how much DEPOSIT has already been redeemed against
// this order. Lets the Order screen show "Deposit paid / Balance due" and
// survive navigation, and lets the Bill screen avoid double-redeeming the same
// deposit. Sums voucher_redemptions of type='deposit' for the order (bill_id).
app.get('/api/orders/:id/deposit-applied', async (req, res) => {
  {
    const cloudId = await localOrderCloudId(req.params.id);
    if (cloudId && await forwardToCloudWith(req, res, 'deposit-applied', {
      path: `/api/orders/${cloudId}/deposit-applied`,
    })) return;
  }
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(vr.amount_used),0) AS applied,
              MAX(v.code) AS code
         FROM voucher_redemptions vr
         JOIN vouchers v ON v.id = vr.voucher_id
        WHERE vr.bill_id = $1 AND v.type = 'deposit'`,
      [req.params.id]);
    const applied = Number(r.rows[0]?.applied || 0);
    res.json({ applied, code: applied > 0 ? (r.rows[0].code || null) : null });
  } catch (err) { res.json({ applied: 0, code: null }); }
});

// SEPOS-DEPOSIT-REMOVE-001 (canary find #9) — un-apply a deposit from a bill:
// restores each deposit-voucher's balance and deletes the redemption rows, so
// a mistaken entry (wrong code, wrong amount) is fully reversible before pay.
app.post('/api/orders/:id/deposit-unapply', async (req, res) => {
  // Canary #12 — translate the LOCAL order id to its cloud id (same as the
  // deposit-applied lookup); without it the cloud searched a wrong bill_id
  // and 'removed' nothing.
  {
    const cloudId = await localOrderCloudId(req.params.id);
    if (cloudId && await forwardToCloudWith(req, res, 'deposit-unapply', {
      path: `/api/orders/${cloudId}/deposit-unapply`,
    })) return;
  }
  try {
    const rows = (await pool.query(
      `SELECT vr.id, vr.voucher_id, vr.amount_used FROM voucher_redemptions vr
        JOIN vouchers v ON v.id = vr.voucher_id
       WHERE vr.bill_id = $1 AND v.type = 'deposit'`, [req.params.id])).rows;
    let restored = 0;
    for (const r of rows) {
      await pool.query(`UPDATE vouchers SET balance = balance + $1, status = 'active' WHERE id = $2`, [r.amount_used, r.voucher_id]);
      await pool.query('DELETE FROM voucher_redemptions WHERE id = $1', [r.id]);
      restored += Number(r.amount_used);
    }
    res.json({ success: true, restored });
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
    // SEPOS-TA-COLLECT-001 — 'collected' CLOSES the bill, so an unpaid
    // pay-on-collection order must be refused until staff record the tender
    // (Cash/Card on the payment screen). Without this, one tap could close a
    // real order with no money ever entering the Z. Prepaid (Stripe 'paid' /
    // demo 'mock') and fully-tendered orders pass as before.
    if (status === 'collected') {
      const cover = await pool.query(
        `SELECT o.payment_status,
                COALESCE((SELECT SUM(amount) FROM payments
                           WHERE order_id = o.id AND COALESCE(method,'') <> 'cancelled'), 0) AS paid,
                COALESCE((SELECT ${ORDER_TOTAL_EXPR} FROM order_items
                           WHERE order_id = o.id AND voided = 0), 0) AS total
           FROM orders o WHERE o.id = $1 AND o.order_type = 'takeaway'`,
        [req.params.id]);
      const c = cover.rows[0];
      if (!c) return res.status(404).json({ error: 'Order not found' });
      const prepaid = c.payment_status === 'paid' || c.payment_status === 'mock';
      const covered = Number(c.paid) + 0.005 >= Number(c.total);
      if (!prepaid && !covered) {
        return res.status(402).json({
          error: 'Take payment first — this order is pay-on-collection. Open its bill and record cash or card.',
          needs_payment: true,
        });
      }
    }
    await pool.query('UPDATE orders SET takeaway_status=$1 WHERE id=$2 AND order_type=\'takeaway\'', [status, req.params.id]);
    if (status === 'collected') {
      // (service_charge=0 — takeaway never carries service; stamps the snapshot)
      await pool.query(`UPDATE orders SET status='closed', closed_at=NOW(), service_charge=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [req.params.id]);
      await pool.query("UPDATE order_items SET status='served', served_at=NOW() WHERE order_id=$1 AND status<>'served'", [req.params.id]);
    }
    // SEPOS-AUDIT-001 — push the status (and the 'collected' close) to the
    // cloud; without it the cloud copy stayed open and the pull reopened the
    // collected takeaway on the Kitchen screen no matter how often staff
    // tapped Collected.
    await offlineQueue.enqueue('takeaway_status', {
      localOrderId: Number(req.params.id), status,
    });
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
    // SEPOS-TA-COLLECT-001 — same money guard as the Collected tap: a
    // delivered-but-UNPAID order (pay-on-collection tenant) must stay open
    // for staff to record the tender; only prepaid/fully-tendered auto-close.
    const cover = await pool.query(
      `SELECT o.payment_status,
              COALESCE((SELECT SUM(amount) FROM payments
                         WHERE order_id = o.id AND COALESCE(method,'') <> 'cancelled'), 0) AS paid,
              COALESCE((SELECT ${ORDER_TOTAL_EXPR} FROM order_items
                         WHERE order_id = o.id AND voided = 0), 0) AS total
         FROM orders o WHERE o.id = $1`, [order.id]);
    const c = cover.rows[0] || {};
    const settled = c.payment_status === 'paid' || c.payment_status === 'mock'
      || Number(c.paid || 0) + 0.005 >= Number(c.total || 0);
    if (!settled) {
      console.warn(`[courier] order #${order.id} delivered but NOT paid — left open for staff to record the tender`);
      io.emit('takeaway_status', { order_id: order.id, status: 'delivered_unpaid' });
      return;
    }
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
    await ensureOpenSession(); // SEPOS-AUTO-SESSION-001 — delivery orders count in the shift too

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
    // SEPOS-ORDER-CHIME-001 — Deliveroo arrivals only emitted the generic
    // items event, so everything keyed on new_takeaway_order (kitchen popup,
    // takeaway strip refresh, native auto-print, the new arrival chime)
    // treated them as invisible. Same event shape as the widget path; the
    // relay already forwards it to local tills.
    io.emit('new_takeaway_order', {
      id: orderId,
      customer_name: parsed.customerName,
      customer_phone: parsed.customerPhone,
      pickup_time: parsed.pickupTime,
      total: null,
      item_count: parsed.items.length,
      order_subtype: 'delivery',
      delivery_address: null,
      source: 'deliveroo',
    });
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
// SEPOS-OWNER-ALERT-001 (Korakot, 26 Aug) — email the RESTAURANT when an
// online order/booking lands. The till strip + print is the primary channel;
// this is the safety net for the till being off, a printer down, or staff
// missing the screen (a £99.70 online order sat unseen the night before a
// go-live). Recipient: settings.restaurant_notify_email, falling back to the
// tenant's RESTAURANT_EMAIL env. Silently skipped when neither is set.
async function sendRestaurantAlert(subject, bodyHtml) {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'restaurant_notify_email'`);
    const to = (r.rows[0] && String(r.rows[0].value || '').trim()) || process.env.RESTAURANT_EMAIL || '';
    if (!to || !to.includes('@')) return;
    const th = await require('./services/brandTheme').getBrandTheme();
    const name = process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant';
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,sans-serif;color:#1a1a2e;">
    <table cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
      <table cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:12px;overflow:hidden;">
        <tr><td style="background:${th.primaryHex};padding:18px 26px;color:${th.accentHex};font-family:Georgia,serif;font-size:20px;font-weight:700;">${name} — staff alert</td></tr>
        <tr><td style="padding:24px 26px;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:14px 26px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#888;">Also on your till as usual — this email is the backup channel.</td></tr>
      </table></td></tr></table></body></html>`;
    await sendBrevoEmail(to, subject, html);
  } catch (err) { console.error('[owner-alert]', err.message); }
}

async function sendTakeawayConfirmation({ order_id, customer_name, customer_email, pickup_time, items, total, paid }) {
  const { sendBrevoEmail } = require('./services/emailService');
  if (!process.env.BREVO_API_KEY) return;
  const restaurantName = process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant';
  const th = await require('./services/brandTheme').getBrandTheme(); // restaurant's own brand colours
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
      <tr><td style="background:${th.primaryHex};padding:24px 30px;color:${th.accentHex};font-family:Georgia,serif;font-size:24px;font-weight:700;">${restaurantName}</td></tr>
      <tr><td style="padding:30px;font-size:15px;line-height:1.6;color:#1a1a2e;">
        <p>Hi ${String(customer_name).replace(/[<>]/g,'')},</p>
        <p>Thanks for your takeaway order. We'll have it ready for collection at:</p>
        <p style="background:#fef3c7;padding:14px 18px;border-radius:10px;font-weight:700;text-align:center;">🥡 ${pickupStr}</p>
        <p>Your order number is <strong style="font-size:18px;color:${th.primaryHex};">${orderNumber}</strong> — please quote this when collecting.</p>
        <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">
          ${itemRows}
          <tr><td style="padding:10px 0 6px;border-top:2px solid #eee;font-weight:800;">Total</td>
              <td style="padding:10px 0 6px;border-top:2px solid #eee;text-align:right;font-weight:800;">£${Number(total).toFixed(2)}</td></tr>
        </table>
        <p style="color:#888;font-size:13px;">${paid ? '✅ Paid online — nothing to pay when you collect.' : 'Payment on collection. Cash or card accepted.'}</p>
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

// SEPOS-BIRTHDAY-001 — full profiles list for the till sync pull (secret
// carries auth; also readable by signed-in admins).
app.get('/api/customer-profiles', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const r = await pool.query('SELECT contact_key, birthday FROM customer_profiles');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-BIRTHDAY-001 — set/clear a customer's birthday ('MM-DD', no year).
// Body: { email?, phone?, birthday } — key derived exactly like the CRM view
// (lower(email), else 'p:'+phone). birthday '' clears it.
app.put('/api/customers/birthday', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const key = email || (phone ? 'p:' + phone : '');
    if (!key) return res.status(400).json({ error: 'email or phone required' });
    const birthday = String(req.body.birthday || '').trim();
    if (birthday === '') {
      await pool.query('DELETE FROM customer_profiles WHERE contact_key = $1', [key]);
      await offlineQueue.enqueue('set_customer_birthday', { email, phone, birthday: '' });
      return res.json({ success: true, cleared: true });
    }
    const m = birthday.match(/^(\d{2})-(\d{2})$/);
    const mm = m ? Number(m[1]) : 0, dd = m ? Number(m[2]) : 0;
    if (!m || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      return res.status(400).json({ error: 'birthday must be MM-DD' });
    }
    await pool.query(
      `INSERT INTO customer_profiles (contact_key, birthday, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (contact_key) DO UPDATE SET birthday = $2, updated_at = CURRENT_TIMESTAMP`,
      [key, birthday]
    );
    // SEPOS-BIRTHDAY-SYNC-001 — mirror to cloud from a local till (no-op on cloud)
    await offlineQueue.enqueue('set_customer_birthday', { email, phone, birthday });
    res.json({ success: true, birthday });
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

function buildCampaignEmail({ subject, body, customer_name, customer_email, restaurantName, restaurantAddress, th }) {
  const primaryHex = (th && th.primaryHex) || '#0D1B3E'; // restaurant brand, SiamEPOS navy fallback
  const accentHex  = (th && th.accentHex)  || '#C9A84C';
  const safeName = (customer_name || 'there').replace(/[<>]/g, '');
  const personalisedBody = String(body || '').replace(/\{\{\s*name\s*\}\}/gi, safeName);
  const unsubUrl = `${process.env.PUBLIC_API_URL || 'https://restaurant-epos-production.up.railway.app'}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(customer_email))}`;
  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a2e;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr><td style="background:${primaryHex};padding:24px 30px;color:${accentHex};font-family:Georgia,serif;font-size:24px;font-weight:700;">${restaurantName}</td></tr>
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
    const th = await require('./services/brandTheme').getBrandTheme(); // restaurant brand — fetched once for the whole send

    let sent = 0, failed = 0;
    for (const c of recipients) {
      const html = buildCampaignEmail({
        subject, body,
        customer_name:  c.customer_name,
        customer_email: c.customer_email,
        restaurantName, restaurantAddress, th,
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

    // SEPOS-BIRTHDAY-001 — attach birthdays from the side-table + compute
    // days until the NEXT occurrence (wraps the year end; 29 Feb rolls to
    // 1 Mar in non-leap years via JS Date overflow).
    const profRes = await pool.query('SELECT contact_key, birthday FROM customer_profiles').catch(() => ({ rows: [] }));
    const birthdayByKey = new Map(profRes.rows.map(p => [p.contact_key, p.birthday]));
    const daysToBirthday = (mmdd, today) => {
      const m = String(mmdd || '').match(/^(\d{2})-(\d{2})$/);
      if (!m) return null;
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      let next = new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
      if (next < startOfToday) next = new Date(today.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
      return Math.round((next - startOfToday) / 86400000);
    };

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

      const birthday = birthdayByKey.get(c.contact_key) || null;
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
        birthday,
        days_to_birthday: birthday ? daysToBirthday(birthday, today) : null,
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
             o.discount_type AS bill_discount_type, o.discount_value AS bill_discount_value,
             o.discount_scope AS bill_discount_scope
      FROM order_items oi
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      LEFT JOIN categories  c  ON c.id  = COALESCE(mi.category_id, oi.dest_category_id)
      LEFT JOIN orders      o  ON o.id  = oi.order_id
      WHERE o.status='closed' AND oi.voided=0
        AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
        AND ((o.order_type = 'takeaway' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (p.method = 'cancelled' OR p.method = 'Complimentary' OR COALESCE(p.method,'') LIKE '%(mock)%'))) OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND COALESCE(p.method,'') <> 'cancelled' AND COALESCE(p.method,'') <> 'Complimentary' AND COALESCE(p.method,'') NOT LIKE '%(mock)%'))
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
      base *= rowBillFactor(vatFactors, row); // distribute the order's bill-level discount (scope-aware)
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

// SEPOS-CLOCK-002 — one-button clock toggle for the login screen's clock mode.
// The till can't know whether the staff member is currently in or out, so the
// server looks at their LAST event and records the opposite. Returns which
// action was taken so the screen can confirm "Clocked IN/OUT at HH:MM".
app.post('/api/clock/toggle', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN required' });
    const staffRes = await pool.query('SELECT id, name FROM staff WHERE pin=$1 AND is_active=1', [pin]);
    const staff = staffRes.rows[0];
    if (!staff) return res.status(401).json({ error: 'Invalid PIN' });
    const last = await pool.query(
      'SELECT event_type FROM clock_events WHERE staff_id=$1 ORDER BY event_at DESC, id DESC LIMIT 1',
      [staff.id]
    );
    const next = last.rows[0] && last.rows[0].event_type === 'in' ? 'out' : 'in';
    await pool.query('INSERT INTO clock_events (staff_id, event_type) VALUES ($1, $2)', [staff.id, next]);
    res.json({ success: true, staff_id: staff.id, name: staff.name, event_type: next, event_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  let failed = 0;
  try {
    const r = await pool.query("SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0");
    pending = Number(r.rows[0]?.n || 0);
    const rf = await pool.query("SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 2");
    failed = Number(rf.rows[0]?.n || 0);
  } catch {}
  res.json({
    db_mode: dbMode,
    sync_secret_set: syncSecretSet,
    pending_actions: pending,
    failed_actions: failed,
    // Healthy when in cloud mode (no sync needed) OR in local mode with the
    // secret set, no big pending backlog, and nothing quarantined.
    healthy: dbMode === 'cloud' || (syncSecretSet && pending < 20 && failed === 0),
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
    // synced: 0 = pending, 2 = quarantined (a push that will never succeed —
    // surfaced so a failed payment/order is visible, not silently dropped).
    const r = await pool.query(
      `SELECT id, action_type, payload, created_at, attempts, last_error, failed_at, synced
       FROM sync_queue WHERE synced IN (0, 2) ORDER BY synced ASC, id ASC`
    );
    const map = row => {
      let parsed = null;
      try { parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
      catch {}
      return {
        id: row.id, action_type: row.action_type,
        created_at: row.created_at, payload: parsed,
        attempts: Number(row.attempts) || 0,
        last_error: row.last_error || null,
        failed_at: row.failed_at || null,
        failed: row.synced === 2,
      };
    };
    const rows = r.rows.map(map);
    // entries = pending (back-compat with the existing modal); failed = quarantined.
    res.json({
      db_mode: dbMode,
      entries: rows.filter(e => !e.failed),
      failed: rows.filter(e => e.failed),
    });
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
    // Clear a pending (0) OR quarantined (2) entry — dismiss it without pushing.
    const r = await pool.query(
      `UPDATE sync_queue SET synced = 1, synced_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND synced IN (0, 2)`,
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
// SEPOS-SYNC-TENDERS-001 — tenders for ONE order, by cloud id. Lets a till
// repair an order whose payments never landed, without replaying whole pages of
// closed-order history (the cursor only moves forward, so a skipped order is
// otherwise stranded for good).
app.get('/api/sync/order-payments/:id', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'SYNC_SECRET not set on this server' });
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });
  try {
    const r = await pool.query('SELECT * FROM payments WHERE order_id = $1 ORDER BY id', [req.params.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

// SEPOS-REMINDER-001 — manual trigger for the day-before reminder check
// (testing/support). Reports candidates found vs actually sent. Pass
// {force:true} to bypass the 09:00–12:00 morning send-window (the created-a-day-
// ahead rule still applies — a same-day booking is never remindable).
// SEPOS-AUDIT-002 F29 — was unauthenticated: anyone could fire tomorrow's
// reminders at 3am and, because each send is recorded, permanently burn them so
// the real 09:00 run sent nothing. The internal cron calls runReminderCheck
// directly and is unaffected.
app.post('/api/webhooks/run-reminders', requireStaffAuthOrSyncSecret(['admin', 'manager']), async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === '1';
    const result = await require('./services/reminderService').runReminderCheck({ force });
    res.json({ success: true, ...result });
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
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
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
      // Identity on the slip: the big table-heading prints the TARGET the
      // operator typed, so with several printers you can tell which one
      // answered ("TEST 192.168.68.201").
      table_label: `TEST ${ip || printer_name}`,
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
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
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
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
  }
});

// ── SEPOS-ANDROID-001 — ESC/POS buffers for the native Android app ──────────
// The cloud can't reach a LAN printer, so the Android app PULLS the bytes and
// sends them to the printer itself (native TCP plugin). Same builders as the
// desktop path → byte-identical formatting (Thai, £, logo, cut). Returns base64.
app.get('/api/print/buffers/test', async (req, res) => {
  try {
    // Optional ?ip=&name=&port= — the native app knows which printer it is
    // about to push this buffer to; echoing it on the slip identifies the
    // printer (three identical POS80s, one shelf).
    const { ip, name, port } = req.query || {};
    const buf = printService.buildTestPage({ ip, name, port });
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
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
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
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
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
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
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
    let resolvedTable = table_number || '', resolvedLabel = '', resolvedType = 'dine_in', resolvedCustomer = customer_name || '';
    // Always resolve when we have the order — the table NAME only lives
    // server-side, and a client-sent bare number must not skip it.
    if (order_id) {
      const r = await pool.query(
        `SELECT o.order_type, o.customer_name, t.table_number, t.name AS table_label, t.is_takeaway AS table_is_takeaway
         FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = $1`, [order_id]
      ).catch(() => ({ rows: [] }));
      const o = r.rows[0];
      if (o) { resolvedTable = resolvedTable || o.table_number || ''; resolvedLabel = (o.table_label && String(o.table_label).trim()) || ''; resolvedType = o.order_type || 'dine_in'; resolvedCustomer = o.customer_name || customer_name || ''; }
    }
    const buf = printService.buildKitchenMessage({
      order_id, table_number: resolvedTable, table_label: resolvedLabel, order_type: resolvedType,
      customer_name: resolvedCustomer, message: text, waiter_name: waiter_name || '',
    });
    res.json({ ok: true, data: Buffer.from(buf).toString('base64'), bytes: buf.length });
  } catch (err) {
    console.error('[print/buffers/kitchen-message]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/print/receipt', async (req, res) => {
  const { order_id, payment_details, printer_name, printer_id } = req.body;
  try {
    const settings = await loadSettings();
    // SEPOS-058 — a USB printer is addressed by NAME (no IP). When the client
    // passes printer_name (the desktop's selected device), print by name via
    // the platform raw path (Windows spooler RAW / CUPS) instead of requiring
    // an IP. This gives crisp ESC/POS black + silent, vs the faint HTML/GDI path.
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    // SEPOS-BILL-STATIONS-001 — per-DEVICE bill station: the client passes the
    // printers-table row id it wants THIS device's bills on (multi-section
    // venues: each section's till prints bills at its own station). Falls back
    // to the role_receipt default when the row is missing/inactive — a stale
    // device preference must never mean "no bill".
    if (printer_id) {
      const pr = await pool.query(
        `SELECT ip, port, name, lpr_queue FROM printers WHERE id = $1 AND is_active = 1`, [Number(printer_id)]);
      if (pr.rows[0] && pr.rows[0].ip) {
        settings.printer_receipt_ip = pr.rows[0].ip;
        settings.printer_receipt_port = pr.rows[0].port || 9100;
        settings.printer_receipt_lpr_queue = pr.rows[0].lpr_queue || settings.printer_receipt_lpr_queue;
        settings.printer_receipt_name = '';
        console.log(`[print/receipt] device override → station "${pr.rows[0].name}" (${pr.rows[0].ip})`);
      } else {
        console.warn(`[print/receipt] override printer_id=${printer_id} missing/inactive — using default station`);
      }
    }
    if (printer_name) { settings.printer_receipt_name = printer_name; settings.printer_receipt_ip = ''; }
    if (!settings.printer_receipt_ip && !settings.printer_receipt_name) return res.json({ success: false, reason: 'no_printer' });
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
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
    // SEPOS-SPLIT-PRINT-001 — Split-by-Item: the client names the person's
    // exact lines; print ONLY those (previously every split receipt carried
    // the whole order's items under one person's total). Quantity + line
    // discount come from the client's split (a person can take 2 of a line's
    // 3 units). Unknown ids (stale client) → full list, never a blank receipt.
    let receiptItems = itemsRes.rows;
    const splitLines = Array.isArray(payment_details?.split_items) ? payment_details.split_items : null;
    if (splitLines && splitLines.length) {
      const byId = new Map(splitLines.map(s => [Number(s.id), s]));
      const filtered = receiptItems
        .filter(r => byId.has(Number(r.id)))
        .map(r => {
          const s = byId.get(Number(r.id));
          return {
            ...r,
            quantity: Number(s.quantity) > 0 ? Number(s.quantity) : r.quantity,
            ...(s.discount_value != null ? { discount_value: s.discount_value } : {}),
          };
        });
      if (filtered.length) receiptItems = filtered;
    }
    await printService.printReceipt(settings, order, receiptItems, payment_details || {});
    res.json({ success: true });
  } catch (err) {
    console.error('[print/receipt]', err.message);
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
  }
});

// SEPOS-DRAWER-001 — open the cash drawer on payment. Kicks the RECEIPT
// printer's drawer port (raw ESC/POS). Gated by open_drawer_on_payment
// (default ON — only '0' disables). No printer / unreachable → silent skip;
// never blocks the payment. printer_name overrides the receipt device.
app.post('/api/print/drawer', async (req, res) => {
  // SEPOS-DRAWER-002 — manual:true is the navbar 💵 button (no-sale open:
  // change-making, float). It bypasses the open_drawer_on_payment toggle
  // (that governs only the automatic on-payment kick) and stamps who did it.
  const { printer_name, manual, staff_name } = req.body || {};
  // The drawer kicks a printer on the LAN — only reachable from a local-server
  // till (desktop/Sunmi, DB_MODE=local). On the cloud backend the printer is
  // unreachable and the RAW→LPR→CUPS fallback would burn ~15s per payment, so
  // skip instantly. (Fires per payment, so speed matters.)
  if (String(process.env.DB_MODE || '').toLowerCase() !== 'local') {
    return res.json({ success: false, skipped: 'not a local till' });
  }
  try {
    const settings = await loadSettings();
    if (!manual && settings.open_drawer_on_payment === '0') return res.json({ success: false, skipped: 'disabled' });
    await applyPrinterRouting(settings);
    if (printer_name) { settings.printer_receipt_name = printer_name; settings.printer_receipt_ip = ''; }
    if (!settings.printer_receipt_ip && !settings.printer_receipt_name) return res.json({ success: false, reason: 'no_printer' });
    if (manual) console.log(`[drawer] manual open by ${staff_name || 'unknown'} at ${new Date().toISOString()}`);
    await printService.openCashDrawer(settings);
    res.json({ success: true });
  } catch (err) {
    console.error('[print/drawer]', err.message);
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
  }
});

// ── SEPOS-STATION-002 — per-station routing for DINE-IN server prints ────────
// SEPOS-STATION-001 gave takeaway auto-print per-category stations, but the
// dine-in endpoints below always printed to the single role printer, so a
// desktop/browser till could never split sushi/starter/hot-kitchen stations
// (only the native Sunmi till could, client-side). This helper mirrors the
// takeaway router: items whose category has printers.printer_id assigned go
// to that station; everything else stays on the role default. Fail-safe: a
// station whose print FAILS returns its items to the default group so food
// is never silently lost — worst case it prints at the main kitchen printer.
async function splitPrintItemsByStation(items) {
  const list = Array.isArray(items) ? items : [];
  const menuIds = [...new Set(list.map(it => it && it.menu_item_id).filter(Boolean).map(Number))];
  if (!menuIds.length) return { def: list, stations: [] };
  try {
    // SEPOS-STATION-003 — dish-level override wins over the category route.
    const rows = await pool.query(
      `SELECT mi.id, COALESCE(mi.printer_id, c.printer_id) AS printer_id
         FROM menu_items mi LEFT JOIN categories c ON mi.category_id = c.id
        WHERE mi.id = ANY($1)`, [menuIds]);
    const printerByMenuId = new Map(rows.rows.map(r => [Number(r.id), r.printer_id]));
    const stationRows = (await pool.query(
      "SELECT * FROM printers WHERE is_active = 1 AND ip IS NOT NULL AND ip != ''"
    ).catch(() => ({ rows: [] }))).rows;
    const stationById = new Map(stationRows.map(p => [Number(p.id), p]));
    const def = [], groups = new Map(); // printer_id -> { printer, items }
    for (const it of list) {
      const pid = it && it.menu_item_id != null ? printerByMenuId.get(Number(it.menu_item_id)) : null;
      const station = pid != null ? stationById.get(Number(pid)) : null;
      if (!station) { def.push(it); continue; }
      if (!groups.has(station.id)) groups.set(station.id, { printer: station, items: [] });
      groups.get(station.id).items.push(it);
    }
    return { def, stations: [...groups.values()] };
  } catch (err) {
    // Any lookup problem → behave exactly as before the feature existed.
    console.warn('[print/stations] split failed, using single-printer path:', err.message);
    return { def: list, stations: [] };
  }
}

// Print station groups; returns items whose station print FAILED (rescue →
// caller adds them back to the default-kitchen ticket so nothing is lost).
async function printStationGroups(stations, settings, order) {
  const rescued = [];
  for (const g of stations) {
    try {
      await printService.printKitchenToPrinter(g.printer, settings, order, g.items);
      console.log(`🖨️ Station "${g.printer.name}" printed ${g.items.length} item(s) for order #${order.id}`);
    } catch (err) {
      if (printAlerts.isLocal) {
        // SEPOS-PRINT-ALERT-001 — on a till, a dead station must be LOUD,
        // never a silent hand-off: hold the ticket + banner the staff, who
        // choose retry or an explicit redirect to the main kitchen.
        const held = await printAlerts.recordFailure({
          kind: 'station', printer: g.printer, order, items: g.items, reason: err.message,
        });
        // Verify pass (MEDIUM) — if the hold itself failed to record (DB error),
        // the food would otherwise be lost silently: fall back to the rescue so
        // it at least prints on the main kitchen.
        if (!held) {
          console.error(`[print/stations] station "${g.printer.name}" hold FAILED to record — rescuing items to main kitchen`);
          rescued.push(...g.items);
        }
      } else {
        // Cloud path keeps the legacy silent rescue (no staff UI to alert).
        console.error(`[print/stations] station "${g.printer.name}" failed (${err.message}) — rescuing items to main kitchen`);
        rescued.push(...g.items);
      }
    }
  }
  return rescued;
}

// Print a kitchen ticket for a given order + course
app.post('/api/print/kitchen', async (req, res) => {
  const { order_id, items, course, printer_name, copies } = req.body;
  try {
    const settings = await loadSettings();
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_kitchen_name = printer_name; settings.printer_kitchen_ip = ''; }
    if (copies) settings.printer_kitchen_copies = String(copies); // client-resolved copies (per-device or system)
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = orderRes.rows[0];
    // SEPOS-STATION-002 — split by station, print stations, rescue failures.
    const split = await splitPrintItemsByStation(items || []);
    const rescued = split.stations.length ? await printStationGroups(split.stations, settings, order) : [];
    const defItems = [...split.def, ...rescued];
    if (defItems.length) {
      if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) return res.json({ success: false, reason: 'no_printer' });
      try {
        await printService.printKitchenTicket(settings, order, defItems, course || 1);
      } catch (err) {
        // SEPOS-PRINT-ALERT-001 — hold + banner on tills; rethrow keeps the API contract.
        err.ticketHeld = await printAlerts.recordFailure({ kind: 'kitchen', printer: { name: 'Kitchen', ip: settings.printer_kitchen_ip }, order, items: defItems, reason: err.message });
        throw err;
      }
    } else if (!split.stations.length) {
      // No items at all and no stations — keep the legacy no_printer contract.
      if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) return res.json({ success: false, reason: 'no_printer' });
      await printService.printKitchenTicket(settings, order, [], course || 1);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[print/kitchen]', err.message);
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
  }
});

// Print a bar ticket
app.post('/api/print/bar', async (req, res) => {
  const { order_id, items, printer_name } = req.body;
  try {
    const settings = await loadSettings();
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_bar_name = printer_name; settings.printer_bar_ip = ''; }
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = orderRes.rows[0];
    // SEPOS-STATION-002 — a drinks category can also be routed to a station
    // (e.g. a coffee/dessert-bar printer); unmatched items keep the bar default.
    const split = await splitPrintItemsByStation(items || []);
    const rescued = split.stations.length ? await printStationGroups(split.stations, settings, order) : [];
    const defItems = [...split.def, ...rescued];
    if (defItems.length || !split.stations.length) {
      if (!settings.printer_bar_ip && !settings.printer_bar_name) return res.json({ success: false, reason: 'no_printer' });
      try {
        await printService.printBarTicket(settings, order, defItems);
      } catch (err) {
        err.ticketHeld = await printAlerts.recordFailure({ kind: 'bar', printer: { name: 'Bar', ip: settings.printer_bar_ip }, order, items: defItems, reason: err.message });
        throw err;
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[print/bar]', err.message);
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
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
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    await printService.printFireNotice(settings, orderRes.rows[0], course || 1);
    res.json({ success: true });
  } catch (err) {
    console.error('[print/kitchen-fire]', err.message);
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
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
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number, tables.name AS table_label, tables.is_takeaway AS table_is_takeaway
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = orderRes.rows[0];
    // SEPOS-STATION-002 — split by station, print stations, rescue failures
    // back onto the main kitchen ticket so no dish is silently lost.
    const split = await splitPrintItemsByStation(items || []);
    const rescued = split.stations.length ? await printStationGroups(split.stations, settings, order) : [];
    const defItems = [...split.def, ...rescued];
    if (defItems.length || !split.stations.length) {
      if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) return res.json({ success: false, reason: 'no_printer' });
      try {
        await printService.printFullKitchenTicket(settings, order, defItems);
      } catch (err) {
        err.ticketHeld = await printAlerts.recordFailure({ kind: 'kitchen', printer: { name: 'Kitchen', ip: settings.printer_kitchen_ip }, order, items: defItems, reason: err.message });
        throw err;
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[print/kitchen-full]', err.message);
    // F12 — a HELD ticket is not a plain failure: the client must not fall
    // through and print it again (that made the banner a lie and turned a later
    // Retry into a duplicate ticket).
    res.json({ success: false, held: !!err.ticketHeld, error: err.message });
  }
});

// ── SEPOS-PRINT-ALERT-001 — held-ticket queue + printer health ───────
// Till banner polls this; empty on cloud (service is local-gated).
app.get('/api/print/alerts', async (req, res) => {
  try {
    res.json(await printAlerts.list());
  } catch (err) {
    res.json({ alerts: [], printers: [], error: err.message });
  }
});

// action: 'retry' (original printer, re-resolved from current config) |
//         'redirect' (main kitchen, ticket marked "REDIRECTED FROM …") |
//         'dismiss'
app.post('/api/print/alerts/action', async (req, res) => {
  try {
    const { action, ids, printer_id } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    let results;
    if (action === 'retry') results = await printAlerts.retry(ids);
    else if (action === 'redirect') results = await printAlerts.redirect(ids);
    else if (action === 'reroute') results = await printAlerts.reroute(ids, printer_id); // SEPOS-PRINT-FALLBACK-001
    else if (action === 'dismiss') results = await printAlerts.dismiss(ids);
    else return res.status(400).json({ error: 'unknown action' });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  // SEPOS-REMINDER-001 — day-before booking reminder emails (cloud-only inside).
  require('./services/reminderService').start();
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
