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

const CLOUD_API_URL = process.env.CLOUD_API_URL;

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
