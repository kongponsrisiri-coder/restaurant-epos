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
const pool = require('../db/dbAdapter');

const CLOUD_API_URL = process.env.CLOUD_API_URL;

// SEPOS-046b — when a takeaway order arrives via the public widget on the
// CLOUD, the cloud's own auto-print can't reach the restaurant's LAN
// printer (Railway → 192.168.x.x will never resolve). The desktop install
// IS on the LAN, so the print belongs here on the cloud-relay path.
async function autoPrintIncomingTakeaway(payload) {
  try {
    // Load local settings (KV) — same shape src/server.js loadSettings uses.
    const sRes = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    sRes.rows.forEach(r => { settings[r.key] = r.value; });
    const mode = settings.kitchen_print_mode || 'print';
    if (mode === 'kds') return;
    if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name &&
        !settings.printer_bar_ip) return;

    // Fetch full order + items from cloud. We can't trust the local DB
    // yet — the SQLite pull is racing this print and may not have items
    // populated for sub-second prints.
    const orderRes = await fetch(`${CLOUD_API_URL}/api/orders/${payload.id}`);
    if (!orderRes.ok) {
      console.warn('[cloud-relay] auto-print: order fetch', orderRes.status);
      return;
    }
    const orderData = await orderRes.json();
    const items = orderData.items || [];
    if (items.length === 0) return;

    // Look up is_bar per menu_item via the existing /api/menu/all (cats
    // with is_bar flag, nested items). Fall back to kitchen-only routing
    // if the menu fetch fails.
    const barIdSet = new Set();
    try {
      const menuRes = await fetch(`${CLOUD_API_URL}/api/menu/all`);
      if (menuRes.ok) {
        const cats = await menuRes.json();
        (Array.isArray(cats) ? cats : []).forEach(c => {
          if (Number(c.is_bar) === 1 && Array.isArray(c.items)) {
            c.items.forEach(i => barIdSet.add(i.id));
          }
        });
      }
    } catch {}

    const toPrintItem = (it) => ({
      course: 1,
      quantity: it.quantity || 1,
      name: it.name || it.item_name || 'Item',
      notes: it.notes || (Array.isArray(it.modifiers) ? it.modifiers.map(m => m.name).join(', ') : ''),
    });
    const kitchenItems = items.filter(it => !barIdSet.has(it.menu_item_id)).map(toPrintItem);
    const barItems     = items.filter(it =>  barIdSet.has(it.menu_item_id)).map(toPrintItem);

    const printOrder = {
      id: payload.id,
      order_type: 'takeaway',
      order_subtype: payload.order_subtype || 'collection',
      customer_name: payload.customer_name || '',
      table_number: null,
    };

    if (mode !== 'kds' && kitchenItems.length &&
        (settings.printer_kitchen_ip || settings.printer_kitchen_name)) {
      printService.printFullKitchenTicket(settings, printOrder, kitchenItems)
        .then(() => console.log(`🖨️ [cloud-relay] kitchen ticket auto-printed for takeaway #${payload.id}`))
        .catch(err => console.error('[cloud-relay] kitchen print failed:', err.message));
    }
    if (barItems.length && settings.printer_bar_ip) {
      printService.printBarTicket(settings, printOrder, barItems)
        .then(() => console.log(`🍹 [cloud-relay] bar ticket auto-printed for takeaway #${payload.id}`))
        .catch(err => console.error('[cloud-relay] bar print failed:', err.message));
    }
  } catch (err) {
    console.error('[cloud-relay] auto-print error:', err.message);
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
