// SEPOS-PRO-003 — real-time cloud event relay for the Mac desktop app.
//
// Without this, Mac↔Cloud sync only happens on the pull timer (every 5s).
// That's fine for catching up but feels laggy compared to Chrome↔Chrome,
// where every browser tab subscribes to the cloud's own Socket.io server
// and gets sub-second updates.
//
// This module opens a CLIENT websocket from the Mac's local server to the
// cloud's Socket.io server. When the cloud emits an event ("new_order_items",
// "course_fired", etc.), we:
//   1. trigger a quick local sync so local SQLite has fresh data before
//      React refetches over HTTP
//   2. forward the event to Mac's LOCAL Socket.io so the React app
//      (which is only listening to local events) sees the change live
//
// In cloud mode the relay is a no-op. In local mode it's started by
// server.js with the local `io` instance.

const { io: ioClient } = require('socket.io-client');
const offlineQueue = require('./offlineQueue');
const printService = require('./printService');
const printAlerts = require('./printAlertService'); // SEPOS-PRINT-ALERT-001
const pool = require('../db/dbAdapter');

const CLOUD_API_URL = process.env.CLOUD_API_URL;

// SEPOS-046b — when a takeaway order arrives via the public widget on the
// CLOUD, the cloud's own auto-print can't reach the restaurant's LAN
// printer (Railway → 192.168.x.x will never resolve). The desktop install
// IS on the LAN, so the print belongs here on the cloud-relay path.
// opts (SEPOS-QR-ORDER-001): { qr: true, tableNumber, onlyItemIds } — a QR
// self-order is dine-in on a table, arrives cloud-first exactly like takeaway
// (customer's phone → cloud), and round 2+ must print ONLY the new items.
// F9 — item ids this process has already sent to a printer. Bounded so a long
// running till can't grow it forever; oldest ids age out first.
const alreadyPrintedItemIds = new Set();
function rememberPrintedItem(id) {
  alreadyPrintedItemIds.add(id);
  if (alreadyPrintedItemIds.size > 5000) {
    const it = alreadyPrintedItemIds.values();
    for (let i = 0; i < 1000; i++) { const n = it.next(); if (n.done) break; alreadyPrintedItemIds.delete(n.value); }
  }
}

async function autoPrintIncomingTakeaway(payload, opts = {}) {
  let didPrint = false;
  try {
    // Load local settings (KV) — same shape src/server.js loadSettings uses.
    const sRes = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    sRes.rows.forEach(r => { settings[r.key] = r.value; });
    // SEPOS-AUDIT-002 F23 — the relay never applied the unified-printers
    // overlay, so on a station-only till the legacy printer_kitchen_* keys are
    // empty and the kitchen fallback below was unreachable: an item whose
    // station was deactivated printed NOWHERE and raised NO alert.
    try {
      const rp = (await pool.query('SELECT * FROM printers WHERE is_active = 1 ORDER BY sort_order, id')).rows;
      if (rp && rp.length) {
        const byId = new Map(rp.map(p => [String(p.id), p]));
        for (const role of ['kitchen', 'bar']) {
          const defId = settings[`default_${role}_printer_id`];
          const starred = defId ? byId.get(String(defId)) : null;
          const pick = (starred && Number(starred[`role_${role}`]) === 1 ? starred : null)
            || rp.find(x => Number(x[`role_${role}`]) === 1);
          if (!pick || !(pick.ip || pick.name)) continue;
          // Verify pass (LOW) — never BLANK an existing legacy value with '': a
          // name-only (USB/CUPS) bar printer has no IP, and the bar branch
          // below requires one, so drinks vanished with no alert.
          if (pick.ip) settings[`printer_${role}_ip`] = pick.ip;
          settings[`printer_${role}_port`] = pick.port || 9100;
          settings[`printer_${role}_name`] = pick.name || '';
          if (role === 'kitchen' && pick.copies) settings.printer_kitchen_copies = String(pick.copies);
        }
      }
    } catch {}
    const mode = settings.kitchen_print_mode || 'print';
    if (mode === 'kds') return false;
    // SEPOS-STATION-005 — a station-only setup (printers table rows, no
    // legacy kitchen/bar IP settings) must still print: check both.
    let hasStations = false;
    try {
      const c = await pool.query('SELECT COUNT(*)::int AS n FROM printers');
      hasStations = (c.rows[0]?.n || 0) > 0;
    } catch {}
    if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name &&
        !settings.printer_bar_ip && !hasStations) return false;

    // Fetch full order + items from cloud. We can't trust the local DB
    // yet — the SQLite pull is racing this print and may not have items
    // populated for sub-second prints.
    const orderRes = await fetch(`${CLOUD_API_URL}/api/orders/${payload.id}`);
    if (!orderRes.ok) {
      console.warn('[cloud-relay] auto-print: order fetch', orderRes.status);
      return;
    }
    const orderData = await orderRes.json();
    let items = orderData.items || [];
    // Round 2+ of a QR order appends to the same bill — print only the items
    // this event carried, or the kitchen gets round 1 again on every round.
    if (opts.onlyItemIds && opts.onlyItemIds.length) {
      const allowed = new Set(opts.onlyItemIds.map(Number));
      items = items.filter(it => allowed.has(Number(it.id)));
    }
    if (items.length === 0) return;

    // Look up is_bar AND the effective print station per menu_item via the
    // existing /api/menu/all (cats with is_bar flag + printer_id, nested
    // items with per-dish printer_id override — SEPOS-STATION-003: dish
    // wins over category). Fall back to kitchen-only routing on failure.
    const barIdSet = new Set();
    const stationIdByItem = new Map(); // menu_item_id -> printer_id
    try {
      const menuRes = await fetch(`${CLOUD_API_URL}/api/menu/all`);
      if (menuRes.ok) {
        const cats = await menuRes.json();
        (Array.isArray(cats) ? cats : []).forEach(c => {
          if (!Array.isArray(c.items)) return;
          c.items.forEach(i => {
            if (Number(c.is_bar) === 1) barIdSet.add(i.id);
            const pid = i.printer_id != null ? Number(i.printer_id)
                      : (c.printer_id != null ? Number(c.printer_id) : null);
            if (pid != null) stationIdByItem.set(i.id, pid);
          });
        });
      }
    } catch {}

    // SEPOS-STATION-005 — local station rows (extra printers). Only rows
    // with an IP can be targeted; items whose station is missing/inactive
    // are rescued to the main kitchen ticket below.
    const stationById = new Map();
    try {
      const pRes = await pool.query('SELECT * FROM printers');
      pRes.rows.forEach(p => {
        const active = p.is_active === undefined || p.is_active === null ||
                       Number(p.is_active) === 1;
        if (active && p.ip) stationById.set(Number(p.id), p);
      });
    } catch {}

    const toPrintItem = (it) => ({
      course: 1,
      quantity: it.quantity || 1,
      name: it.name || it.item_name || 'Item',
      // Pass the Thai (or second-language) name through so the kitchen
      // ticket prints bilingual for widget orders. /api/orders/:id
      // already joins menu_items.name_alt — we were just dropping it.
      name_alt: it.name_alt || null,
      notes: it.notes || (Array.isArray(it.modifiers) ? it.modifiers.map(m => m.name).join(', ') : ''),
      // Customer per-item note (textarea on the widget, if used).
      item_note: it.item_note || null,
    });
    // SEPOS-STATION-005 — 3-way split matching the cloud/dine-in path:
    // assigned station (live) → that printer; bar → bar printer; everything
    // else (incl. items whose station is dead/unknown) → main kitchen.
    const stationGroups = new Map(); // printer_id -> { printer, items[] }
    const kitchenItems = [];
    const barItems = [];
    for (const it of items) {
      const sid = stationIdByItem.get(it.menu_item_id);
      const station = sid != null ? stationById.get(sid) : null;
      if (station) {
        if (!stationGroups.has(sid)) stationGroups.set(sid, { printer: station, items: [] });
        stationGroups.get(sid).items.push(toPrintItem(it));
      } else if (barIdSet.has(it.menu_item_id)) {
        barItems.push(toPrintItem(it));
      } else {
        kitchenItems.push(toPrintItem(it));
      }
    }

    const printOrder = opts.qr ? {
      // QR self-order — a dine-in ticket for the table, marked so the kitchen
      // knows no waiter keyed it (and that it's prepaid).
      id: payload.id,
      order_type: 'dine_in',
      source: 'qr',
      customer_name: '',
      customer_phone: '',
      delivery_address: null,
      notes: '📱 QR self-order (prepaid)',
      table_number: opts.tableNumber ?? null,
      table_label: opts.tableLabel ?? null,
    } : {
      id: payload.id,
      order_type: 'takeaway',
      order_subtype: payload.order_subtype || 'collection',
      customer_name: payload.customer_name || '',
      customer_phone: payload.customer_phone || '',
      delivery_address: payload.delivery_address || null,
      notes: payload.notes || null,
      table_number: null,
    };

    // SEPOS-PRINT-ALERT-001 — a failed auto-print on an online order is the
    // WORST silent failure (no staff even saw an order screen): hold + banner.
    for (const [, grp] of stationGroups) {
      printService.printKitchenToPrinter(grp.printer, settings, printOrder, grp.items)
        .then(() => console.log(`🖨️ [cloud-relay] station "${grp.printer.name}" auto-printed for ${opts.qr ? 'QR order' : 'takeaway'} #${payload.id}`))
        .catch(err => printAlerts.recordFailure({ kind: 'station', printer: grp.printer, order: printOrder, items: grp.items, reason: err.message }));
    }
    // F23 — items with no live station AND no kitchen printer must not vanish.
    if (mode !== 'kds' && kitchenItems.length &&
        !settings.printer_kitchen_ip && !settings.printer_kitchen_name) {
      printAlerts.recordFailure({
        kind: 'kitchen', printer: { name: 'Kitchen', ip: null }, order: printOrder, items: kitchenItems,
        reason: 'no kitchen printer configured (station missing or inactive for these items)',
      });
    }
    if (mode !== 'kds' && kitchenItems.length &&
        (settings.printer_kitchen_ip || settings.printer_kitchen_name)) {
      printService.printFullKitchenTicket(settings, printOrder, kitchenItems)
        .then(() => console.log(`🖨️ [cloud-relay] kitchen ticket auto-printed for ${opts.qr ? 'QR order' : 'takeaway'} #${payload.id}`))
        .catch(err => printAlerts.recordFailure({ kind: 'kitchen', printer: { name: 'Kitchen', ip: settings.printer_kitchen_ip }, order: printOrder, items: kitchenItems, reason: err.message }));
    }
    // Verify pass (round 5, HIGH) — accept a name-only (USB/CUPS) bar printer,
    // not just an IP. The gate required printer_bar_ip, so on a name-only setup
    // drinks silently dropped (and, for QR orders, got memoised as printed and
    // never retried). If neither ip nor name is set, HOLD it loudly instead of
    // vanishing.
    if (barItems.length && !settings.printer_bar_ip && !settings.printer_bar_name) {
      printAlerts.recordFailure({ kind: 'bar', printer: { name: 'Bar', ip: null }, order: printOrder, items: barItems, reason: 'no bar printer configured' });
    }
    if (barItems.length && (settings.printer_bar_ip || settings.printer_bar_name)) {
      printService.printBarTicket(settings, printOrder, barItems)
        .then(() => console.log(`🍹 [cloud-relay] bar ticket auto-printed for ${opts.qr ? 'QR order' : 'takeaway'} #${payload.id}`))
        .catch(err => printAlerts.recordFailure({ kind: 'bar', printer: { name: 'Bar', ip: settings.printer_bar_ip }, order: printOrder, items: barItems, reason: err.message }));
    }
    didPrint = true;
    return didPrint;
  } catch (err) {
    console.error('[cloud-relay] auto-print error:', err.message);
    return false;
  }
}

// Every io.emit() call on the cloud side is mirrored here. Adding a new
// event upstream? Add its name to this list to relay it.
const RELAY_EVENTS = [
  'new_order_items',
  'course_fired',
  'item_status_changed',
  'item_voided',
  'order_closed',
  'table_moved',
  'table_merged',
  'new_reservation',
  'reservation_updated',
  'tableStatusChanged',
  'reservation_cancelled',
  'new_takeaway_order',
  'takeaway_status',
  // SEPOS-AUDIT-001 — these four were emitted by the cloud but never
  // relayed, so the desktop till missed them entirely: a cloud-side order
  // delete left a permanent ghost on the floor, a payment amendment never
  // refreshed Bills, kitchen messages and delivery updates went dark.
  'order_deleted',
  'payment_amended',
  'kitchen_message',
  'delivery_status',
  'order_note_updated',  // SEPOS-KITCHEN-MSG-002 — kitchen note attached to an order
];

let cloudSocket = null;
let pullScheduled = false;
let syncServiceRef = null;

// Coalesce repeated cloud events into a single sync pull. If three items
// get fired in quick succession we don't need three full pulls — one is
// enough since pullActiveOrders fetches everything currently open.
function schedulePull() {
  if (pullScheduled) return;
  if (!syncServiceRef) return;
  pullScheduled = true;
  setTimeout(async () => {
    pullScheduled = false;
    try {
      await syncServiceRef.pullActiveOrders();
    } catch (err) {
      console.warn('[cloud-relay] pullActiveOrders after event failed:', err.message);
    }
  }, 150);
}

function start(localIo, syncService) {
  if (!offlineQueue.isLocal) return;          // cloud mode: nothing to relay
  if (!CLOUD_API_URL) return;                 // local but no cloud target
  if (cloudSocket) return;                    // already wired
  syncServiceRef = syncService;

  cloudSocket = ioClient(CLOUD_API_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  cloudSocket.on('connect', () => {
    console.log('[cloud-relay] connected to', CLOUD_API_URL);
  });
  cloudSocket.on('disconnect', (reason) => {
    console.log('[cloud-relay] disconnected:', reason);
  });
  cloudSocket.on('connect_error', (err) => {
    // Quiet on connect errors — these spam when offline. The reconnection
    // logic will keep retrying. We log the first failure only.
    if (!cloudSocket._loggedFailure) {
      console.warn('[cloud-relay] connect error:', err.message);
      cloudSocket._loggedFailure = true;
    }
  });

  for (const event of RELAY_EVENTS) {
    cloudSocket.on(event, (payload) => {
      // Sync local SQLite in the background, but forward the event to the
      // React side IMMEDIATELY so the UI gets a real-time signal that
      // something happened. The follow-up fetch from React will pick up
      // the new data once the pull completes (typically <300ms).
      schedulePull();
      try {
        localIo.emit(event, payload);
      } catch (err) {
        console.warn(`[cloud-relay] forward ${event} failed:`, err.message);
      }
      // SEPOS-046b — auto-print takeaway orders placed via the public
      // widget. Only the local install can reach the LAN printer; cloud's
      // own auto-print is a silent no-op in that case.
      if (event === 'new_takeaway_order' && payload && payload.id) {
        autoPrintIncomingTakeaway(payload);
      }
      // SEPOS-QR-ORDER-001 — QR self-orders are cloud-born like takeaway but
      // announce as new_order_items. Gate on source==='qr' so waiter orders
      // (which also round-trip through the cloud) never double-print.
      if (event === 'new_order_items' && payload && payload.order &&
          payload.order.source === 'qr' && payload.order.id) {
        // SEPOS-AUDIT-002 F9 — this event does NOT always mean "new items": the
        // waiter add-items endpoint emits every item still cooking on the
        // order, so the relay happily reprinted dishes already on the pass.
        // Print each item id at most once per relay process.
        const fresh = (payload.items || []).map(i => i.id).filter(Boolean).filter(id => !alreadyPrintedItemIds.has(id));
        if (fresh.length) {
          // Verify pass (HIGH) — mark them printed only AFTER the print
          // actually ran. Marking first meant any early return inside
          // autoPrintIncomingTakeaway (KDS mode, no printer configured, order
          // fetch failed) suppressed those items forever, silently.
          autoPrintIncomingTakeaway(
            { id: payload.order.id },
            { qr: true, tableNumber: payload.order.table_number ?? null,
              tableLabel: payload.order.table_label ?? null,
              onlyItemIds: fresh })
            .then((printed) => { if (printed) fresh.forEach(id => rememberPrintedItem(id)); })
            .catch(() => { /* leave unmarked so the next event can retry */ });
        } else {
          console.log('[cloud-relay] QR event carried no unprinted items — skipping');
        }
      }
    });
  }

  console.log('[cloud-relay] started — listening for', RELAY_EVENTS.length, 'cloud events');
}

function stop() {
  if (cloudSocket) {
    cloudSocket.disconnect();
    cloudSocket = null;
  }
}

module.exports = { start, stop };
