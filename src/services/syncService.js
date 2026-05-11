// Phase 3 sync engine (push-only). Pings Railway every 30s; when reachable,
// drains sync_queue into the cloud API. Cloud → local pull and full conflict
// resolution remain for Phase 4.
//
// CLOUD_API_URL env var controls the target. If unset, sync stays in local
// mode permanently (queue grows but nothing pushes — safe default for tests).

const offlineQueue = require('./offlineQueue');

const CLOUD_API_URL = process.env.CLOUD_API_URL || '';
const PING_INTERVAL_MS = parseInt(process.env.SYNC_PING_MS || '30000', 10);
const PING_TIMEOUT_MS = 5000;

let status = 'local'; // 'cloud' | 'local' | 'syncing'
let intervalHandle = null;
const subscribers = new Set();

// In-memory local→cloud id map. Rebuilt each sync run as we replay the queue
// from create_order onwards, so a server restart mid-queue still resolves
// correctly (queue itself is persisted in SQLite).
const orderIdMap = new Map();

function setStatus(next) {
  if (next === status) return;
  status = next;
  for (const cb of subscribers) {
    try { cb(status); } catch {}
  }
}

function getStatus() { return status; }

function onStatusChange(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

async function ping() {
  if (!CLOUD_API_URL) return false;
  try {
    const r = await fetch(CLOUD_API_URL + '/api/tables', {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function resolveOrderId(localId) {
  return orderIdMap.get(localId) ?? localId;
}

async function applyToCloud(actionType, payload) {
  const url = (path) => CLOUD_API_URL + path;
  const json = (body) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  switch (actionType) {
    case 'create_order': {
      const r = await fetch(url('/api/orders'), {
        method: 'POST', ...json({ table_id: payload.table_id, covers: payload.covers }),
      });
      if (!r.ok) throw new Error(`create_order ${r.status}`);
      const j = await r.json();
      if (payload.localOrderId && j?.id) {
        orderIdMap.set(payload.localOrderId, j.id);
      }
      return j;
    }
    case 'add_items': {
      const cloudId = resolveOrderId(payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/items`), {
        method: 'POST', ...json({ items: payload.items }),
      });
      if (!r.ok) throw new Error(`add_items ${r.status}`);
      return r.json();
    }
    case 'pay_order': {
      const cloudId = resolveOrderId(payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/pay`), {
        method: 'POST', ...json({ amount: payload.amount, method: payload.method }),
      });
      if (!r.ok) throw new Error(`pay_order ${r.status}`);
      return r.json();
    }
    case 'fire_course': {
      const cloudId = resolveOrderId(payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/fire-course/${payload.course}`), {
        method: 'PUT', ...json({}),
      });
      if (!r.ok) throw new Error(`fire_course ${r.status}`);
      return r.json();
    }
    case 'void_item': {
      // NOTE: order_item ids are not yet translated local→cloud. If the void
      // targets an item that was created offline, the cloud-side id may differ.
      // Phase 4 will add per-item id mapping (likely via UUIDs).
      const r = await fetch(url(`/api/order-items/${payload.localItemId}/void`), {
        method: 'PUT', ...json({ reason: payload.reason }),
      });
      if (!r.ok) throw new Error(`void_item ${r.status}`);
      return r.json();
    }
    default:
      throw new Error('unknown sync action: ' + actionType);
  }
}

async function syncOnce() {
  const queue = await offlineQueue.pending();
  if (queue.length === 0) return;
  setStatus('syncing');
  for (const entry of queue) {
    try {
      await applyToCloud(entry.action_type, entry.payload);
      await offlineQueue.markSynced(entry.id);
    } catch (err) {
      console.error(`[sync] ${entry.action_type}#${entry.id} failed:`, err.message);
      // Stop on first failure; will retry on next tick
      return;
    }
  }
  orderIdMap.clear();
}

async function tick() {
  if (!offlineQueue.isLocal) return;
  const online = await ping();
  if (!online) {
    setStatus('local');
    return;
  }
  await syncOnce();
  // After a successful drain, queue may be empty → cloud.
  const remaining = await offlineQueue.pendingCount();
  setStatus(remaining > 0 ? 'syncing' : 'cloud');
}

function start() {
  if (!offlineQueue.isLocal) {
    console.log('[sync] cloud mode — sync engine not started');
    return;
  }
  if (!CLOUD_API_URL) {
    console.log('[sync] local mode but CLOUD_API_URL unset — staying offline');
    return;
  }
  console.log('[sync] local mode, target=', CLOUD_API_URL, 'interval=', PING_INTERVAL_MS, 'ms');
  // Kick off immediately so status reflects reality on boot
  tick().catch((err) => console.error('[sync] initial tick failed:', err.message));
  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[sync] tick failed:', err.message));
  }, PING_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, getStatus, onStatusChange, syncOnce, tick };
