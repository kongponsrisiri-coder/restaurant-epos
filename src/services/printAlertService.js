// SEPOS-PRINT-ALERT-001 — loud printer-down alerts, never silent.
//
// The till runs fullscreen, so OS-level print errors are invisible. This
// service makes failures LOUD and holds the ticket instead of silently
// printing it somewhere else:
//   • recordFailure() — called where a kitchen/bar/station print throws.
//     The failed ticket is stored (order + items snapshot) as 'pending'.
//   • Staff resolve it from the till banner: retry (original printer,
//     re-resolved from CURRENT config) / redirect (main kitchen, marked
//     "FROM <station>") / dismiss.
//   • A background pinger TCP-probes every configured printer IP so the
//     banner warns BEFORE the first ticket is lost. 2 strikes = down
//     (avoids flapping on a busy printer).
//
// LOCAL-ONLY BY DESIGN: everything is gated on DB_MODE=local (desktop
// install). The cloud copy of this code must stay silent — cloud servers
// can never reach a restaurant's LAN printers, so recording failures
// there would show false "printer down" banners on web tills while the
// local till prints the same ticket fine via the relay.

const net = require('net');

const isLocal = process.env.DB_MODE === 'local';
const PING_INTERVAL_MS = 45 * 1000;
const PING_TIMEOUT_MS = 2500;
const STRIKES_TO_DOWN = 2;

let pool = null;
let io = null;
let printService = null;
let pingTimer = null;

// key ("ip:port") -> { name, ip, port, ok, strikes, last_ok, down_since }
const health = new Map();

function init(deps) {
  pool = deps.pool;
  io = deps.io;
  printService = deps.printService;
  if (isLocal && !pingTimer) {
    pingTimer = setInterval(() => pingAll().catch(() => {}), PING_INTERVAL_MS);
    setTimeout(() => pingAll().catch(() => {}), 5000); // first pass shortly after boot
  }
}

function notify() {
  try { if (io) io.emit('print_alert_changed'); } catch {}
}

// ── Failure queue ────────────────────────────────────────────────────
async function recordFailure({ kind, printer, order, items, reason }) {
  if (!isLocal || !pool) return;
  try {
    await pool.query(
      `INSERT INTO print_failures
         (kind, printer_id, printer_name, printer_ip, order_id, order_label, items, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [
        kind || 'kitchen',
        printer && printer.id != null ? Number(printer.id) : null,
        (printer && printer.name) || (kind === 'bar' ? 'Bar' : 'Kitchen'),
        (printer && (printer.ip || printer.ip_address)) || null,
        order && order.id != null ? Number(order.id) : null,
        buildOrderLabel(order),
        JSON.stringify({ order: snapshotOrder(order), items: items || [] }),
        String(reason || 'print failed').slice(0, 300),
      ]);
    console.error(`[print-alert] HELD ticket for order #${order && order.id} — ${kind} "${printer && printer.name}" (${reason})`);
    notify();
  } catch (err) {
    console.error('[print-alert] recordFailure failed:', err.message);
  }
}

function snapshotOrder(order) {
  if (!order) return {};
  // Only what the ticket renderers actually use — small + stable.
  const o = {};
  for (const k of ['id', 'table_number', 'table_label', 'order_type', 'order_subtype', 'customer_name',
                   'customer_phone', 'delivery_address', 'notes', 'created_at']) {
    if (order[k] !== undefined) o[k] = order[k];
  }
  return o;
}

function buildOrderLabel(order) {
  if (!order) return '';
  if (order.order_type === 'takeaway') return `Online #${order.id} · ${order.customer_name || ''}`.trim();
  const label = order.table_label && String(order.table_label).trim();
  if (label) return label; // table NAME wins over the raw number (Bar 2 ≠ Table 2)
  return order.table_number ? `Table ${order.table_number}` : `Order #${order.id}`;
}

// ── Resolution actions ───────────────────────────────────────────────
async function loadSettingsKV() {
  const r = await pool.query('SELECT key, value FROM settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  // SEPOS-AUDIT-002 F11 — the raw KV only carries the LEGACY fixed
  // printer_{role}_ip keys. On a till configured through the unified Network
  // Printers list (normal since SEPOS-PRINT-UNIFY-001) those are empty, so
  // retry()/redirect() threw 'no kitchen printer configured' for every held
  // ticket and staff could never clear the banner. Same overlay the print
  // routes use.
  try {
    const printers = (await pool.query('SELECT * FROM printers WHERE is_active = 1 ORDER BY sort_order, id')).rows;
    if (printers && printers.length) {
      const byId = new Map(printers.map(p => [String(p.id), p]));
      for (const role of ['receipt', 'kitchen', 'bar']) {
        const defId = s[`default_${role}_printer_id`];
        const starred = defId ? byId.get(String(defId)) : null;
        const p = (starred && Number(starred[`role_${role}`]) === 1 ? starred : null)
          || printers.find(x => Number(x[`role_${role}`]) === 1);
        if (!p || !(p.ip || p.name)) continue;
        s[`printer_${role}_ip`]        = p.ip || '';
        s[`printer_${role}_port`]      = p.port || 9100;
        s[`printer_${role}_name`]      = p.name || '';
        s[`printer_${role}_lpr_queue`] = p.lpr_queue || s[`printer_${role}_lpr_queue`] || 'lp';
        if (role === 'kitchen' && p.copies) s.printer_kitchen_copies = String(p.copies);
      }
    }
  } catch { /* no printers table — legacy keys stand */ }
  return s;
}

async function resolveRows(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  if (!list.length) return [];
  const r = await pool.query(
    `SELECT * FROM print_failures WHERE status = 'pending' AND id = ANY($1)`, [list]);
  return r.rows;
}

async function markResolved(id, status) {
  await pool.query(
    `UPDATE print_failures SET status = $2, resolved_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, status]);
}

async function retry(ids) {
  const rows = await resolveRows(ids);
  const results = [];
  const settings = await loadSettingsKV();
  for (const row of rows) {
    const payload = safeParse(row.items);
    try {
      if (row.kind === 'station' && row.printer_id != null) {
        // Re-resolve the station from CURRENT config — the fix may have
        // been "corrected the IP", so never reuse the stale snapshot.
        const p = await pool.query(
          `SELECT * FROM printers WHERE id = $1 AND is_active = 1 AND ip IS NOT NULL AND ip != ''`,
          [row.printer_id]);
        if (!p.rows.length) throw new Error('station no longer configured');
        await printService.printKitchenToPrinter(p.rows[0], settings, payload.order, payload.items);
      } else if (row.kind === 'bar') {
        if (!settings.printer_bar_ip) throw new Error('no bar printer configured');
        await printService.printBarTicket(settings, payload.order, payload.items);
      } else {
        if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) throw new Error('no kitchen printer configured');
        await printService.printFullKitchenTicket(settings, payload.order, payload.items);
      }
      await markResolved(row.id, 'reprinted');
      results.push({ id: row.id, ok: true });
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err.message });
    }
  }
  notify();
  return results;
}

async function redirect(ids) {
  const rows = await resolveRows(ids);
  const results = [];
  const settings = await loadSettingsKV();
  for (const row of rows) {
    const payload = safeParse(row.items);
    try {
      if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) throw new Error('no kitchen printer configured');
      // Mark the ticket so the kitchen KNOWS it belongs to another station —
      // an explicit hand-off, never a silent one.
      const order = { ...(payload.order || {}) };
      const tag = `⚠ REDIRECTED FROM ${row.printer_name || 'station'}`;
      order.notes = order.notes ? `${tag} · ${order.notes}` : tag;
      await printService.printFullKitchenTicket(settings, order, payload.items);
      await markResolved(row.id, 'redirected');
      results.push({ id: row.id, ok: true });
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err.message });
    }
  }
  notify();
  return results;
}

async function dismiss(ids) {
  const rows = await resolveRows(ids);
  for (const row of rows) await markResolved(row.id, 'dismissed');
  notify();
  return rows.map(r => ({ id: r.id, ok: true }));
}

function safeParse(t) {
  try { return JSON.parse(t) || {}; } catch { return {}; }
}

// ── Listing for the till banner ──────────────────────────────────────
async function list() {
  if (!isLocal || !pool) return { alerts: [], printers: [] };
  const r = await pool.query(
    `SELECT id, kind, printer_id, printer_name, printer_ip, order_id, order_label, reason, created_at
       FROM print_failures WHERE status = 'pending' ORDER BY id`);
  const printers = [...health.values()]
    .filter(h => !h.ok)
    .map(h => ({ name: h.name, ip: h.ip, down_since: h.down_since }));
  return { alerts: r.rows, printers };
}

// ── Printer health pinger ────────────────────────────────────────────
function probe(ip, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(ok); } };
    sock.setTimeout(PING_TIMEOUT_MS);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(Number(port) || 9100, ip); } catch { finish(false); }
  });
}

async function pingAll() {
  if (!isLocal || !pool) return;
  // Collect targets: unified printer rows + legacy role IPs from settings.
  const targets = new Map(); // key -> {name, ip, port}
  try {
    const rows = (await pool.query(
      "SELECT * FROM printers WHERE is_active = 1 AND ip IS NOT NULL AND ip != ''")).rows;
    rows.forEach(p => targets.set(`${p.ip}:${p.port || 9100}`, { name: p.name, ip: p.ip, port: p.port || 9100 }));
  } catch {}
  try {
    const s = await loadSettingsKV();
    [['printer_kitchen_ip', 'Kitchen'], ['printer_bar_ip', 'Bar'], ['printer_receipt_ip', 'Receipt']]
      .forEach(([k, label]) => {
        const ip = s[k];
        if (ip && !targets.has(`${ip}:9100`)) targets.set(`${ip}:9100`, { name: label, ip, port: 9100 });
      });
  } catch {}

  let changed = false;
  for (const [key, t] of targets) {
    const ok = await probe(t.ip, t.port);
    const prev = health.get(key) || { ...t, ok: true, strikes: 0, last_ok: null, down_since: null };
    prev.name = t.name;
    if (ok) {
      if (!prev.ok) changed = true;
      prev.ok = true; prev.strikes = 0; prev.last_ok = new Date().toISOString(); prev.down_since = null;
    } else {
      prev.strikes += 1;
      if (prev.strikes >= STRIKES_TO_DOWN && prev.ok) {
        prev.ok = false; prev.down_since = new Date().toISOString(); changed = true;
        console.warn(`[print-alert] printer DOWN: ${t.name} (${t.ip})`);
      }
    }
    health.set(key, prev);
  }
  // Forget printers no longer configured.
  for (const key of [...health.keys()]) if (!targets.has(key)) { health.delete(key); changed = true; }
  if (changed) notify();
}

module.exports = { init, recordFailure, retry, redirect, dismiss, list, isLocal };
