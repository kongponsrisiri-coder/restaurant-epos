// Phase 3 sync engine (push-only). Pings Railway every 30s; when reachable,
// drains sync_queue into the cloud API. Cloud → local pull and full conflict
// resolution remain for Phase 4.
//
// CLOUD_API_URL env var controls the target. If unset, sync stays in local
// mode permanently (queue grows but nothing pushes — safe default for tests).

const offlineQueue = require('./offlineQueue');
const pool = require('../db/dbAdapter');

const CLOUD_API_URL = process.env.CLOUD_API_URL || '';
const PING_INTERVAL_MS = parseInt(process.env.SYNC_PING_MS || '30000', 10);
const PING_TIMEOUT_MS = 5000;

let status = 'local'; // 'cloud' | 'local' | 'syncing'
let intervalHandle = null;
let inProgress = false;
const subscribers = new Set();

// Flat-shape endpoints pulled directly into a single local table.
// Conflict rule per spec: menu / staff / settings / tables: cloud wins;
// orders: local wins (never pulled). Upsert by PK so existing FKs
// (order_items.menu_item_id, orders.table_id) remain valid across syncs.
// /api/menu/all is handled separately because it returns a nested tree
// (categories → subcategories + items) — see pullMenuTree().
const PULL_TABLES = [
  { path: '/api/tables',                 table: 'tables',                 pk: 'id' },
  { path: '/api/staff',                  table: 'staff',                  pk: 'id' },
  { path: '/api/settings',               table: 'settings',               pk: 'key' },
  { path: '/api/table-walls',            table: 'table_walls',            pk: 'id' },
  { path: '/api/table-combinations',     table: 'table_combinations',     pk: 'id' },
  { path: '/api/dining-duration-tiers',  table: 'dining_duration_tiers',  pk: 'id' },
  { path: '/api/reservations',           table: 'reservations',           pk: 'id' },
];

let initialSyncDone = false;

// SEPOS-PRO-002: cloud_id mapping is now persisted on orders.cloud_id and
// order_items.cloud_id. The in-memory orderIdMap that used to live here
// got wiped on server restart, which was the root cause of sync_queue
// orphans for items voided from earlier sessions.
async function getOrderCloudId(localOrderId) {
  if (localOrderId == null) return null;
  try {
    const r = await pool.query('SELECT cloud_id FROM orders WHERE id = $1', [localOrderId]);
    return r.rows[0]?.cloud_id ?? null;
  } catch { return null; }
}
async function setOrderCloudId(localOrderId, cloudId) {
  if (!localOrderId || !cloudId) return;
  try {
    await pool.query('UPDATE orders SET cloud_id = $1 WHERE id = $2', [cloudId, localOrderId]);
  } catch (err) { console.warn('[sync] setOrderCloudId failed:', err.message); }
}
async function getItemCloudId(localItemId) {
  if (localItemId == null) return null;
  try {
    const r = await pool.query('SELECT cloud_id FROM order_items WHERE id = $1', [localItemId]);
    return r.rows[0]?.cloud_id ?? null;
  } catch { return null; }
}
async function setItemCloudId(localItemId, cloudId) {
  if (!localItemId || !cloudId) return;
  try {
    await pool.query('UPDATE order_items SET cloud_id = $1 WHERE id = $2', [cloudId, localItemId]);
  } catch (err) { console.warn('[sync] setItemCloudId failed:', err.message); }
}
async function findLocalOrderByCloudId(cloudId) {
  if (cloudId == null) return null;
  try {
    const r = await pool.query('SELECT id FROM orders WHERE cloud_id = $1', [cloudId]);
    return r.rows[0]?.id ?? null;
  } catch { return null; }
}
async function findLocalItemByCloudId(cloudId) {
  if (cloudId == null) return null;
  try {
    const r = await pool.query('SELECT id FROM order_items WHERE cloud_id = $1', [cloudId]);
    return r.rows[0]?.id ?? null;
  } catch { return null; }
}

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

async function applyToCloud(actionType, payload) {
  const url = (path) => CLOUD_API_URL + path;
  const json = (body) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  switch (actionType) {
    case 'create_order': {
      // If we've already pushed this local order before (cloud_id is set),
      // don't re-create on the cloud — the queue replay is idempotent.
      const existing = await getOrderCloudId(payload.localOrderId);
      if (existing) return { id: existing };
      const r = await fetch(url('/api/orders'), {
        method: 'POST', ...json({ table_id: payload.table_id, covers: payload.covers }),
      });
      if (!r.ok) throw new Error(`create_order ${r.status}`);
      const j = await r.json();
      if (payload.localOrderId && j?.id) {
        await setOrderCloudId(payload.localOrderId, j.id);
      }
      return j;
    }
    case 'add_items': {
      const cloudId = (await getOrderCloudId(payload.localOrderId)) || payload.localOrderId;
      const r = await fetch(url(`/api/orders/${cloudId}/items`), {
        method: 'POST', ...json({ items: payload.items }),
      });
      if (!r.ok) throw new Error(`add_items ${r.status}`);
      const j = await r.json();
      // If the cloud returned the created items with their ids, store the
      // mapping so subsequent voids/edits know which cloud row to target.
      // Pairing is positional: payload.items[i] ↔ j.items[i] in insert order.
      if (Array.isArray(j?.items) && Array.isArray(payload.items)) {
        for (let i = 0; i < Math.min(j.items.length, payload.items.length); i++) {
          const localItemId = payload.items[i]?.localItemId;
          const cloudItemId = j.items[i]?.id;
          if (localItemId && cloudItemId) await setItemCloudId(localItemId, cloudItemId);
        }
      }
      return j;
    }
    case 'pay_order': {
      const cloudId = (await getOrderCloudId(payload.localOrderId)) || payload.localOrderId;
      const r = await fetch(url(`/api/orders/${cloudId}/pay`), {
        method: 'POST', ...json({ amount: payload.amount, method: payload.method }),
      });
      if (!r.ok) throw new Error(`pay_order ${r.status}`);
      return r.json();
    }
    case 'fire_course': {
      const cloudId = (await getOrderCloudId(payload.localOrderId)) || payload.localOrderId;
      const r = await fetch(url(`/api/orders/${cloudId}/fire-course/${payload.course}`), {
        method: 'PUT', ...json({}),
      });
      if (!r.ok) throw new Error(`fire_course ${r.status}`);
      return r.json();
    }
    case 'void_item': {
      const cloudItemId = (await getItemCloudId(payload.localItemId)) || payload.localItemId;
      const r = await fetch(url(`/api/order-items/${cloudItemId}/void`), {
        method: 'PUT', ...json({ reason: payload.reason }),
      });
      if (!r.ok) throw new Error(`void_item ${r.status}`);
      return r.json();
    }
    default:
      throw new Error('unknown sync action: ' + actionType);
  }
}

async function getLocalColumns(table) {
  const r = await pool.query(`PRAGMA table_info(${table})`);
  return r.rows.map((row) => row.name);
}

async function upsertRows(table, pk, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const localCols = await getLocalColumns(table);
  if (localCols.length === 0) return 0;

  let n = 0;
  for (const row of rows) {
    // Build the column list per row, dropping null/undefined cloud values so
    // they don't clobber non-null local defaults (e.g. staff.is_active=1 from
    // the seed when cloud returns is_active=null, or pin which cloud never
    // sends at all but local needs to keep).
    const cols = Object.keys(row).filter(
      (c) => localCols.includes(c) && row[c] !== null && row[c] !== undefined
    );
    if (!cols.includes(pk)) continue;

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const updateCols = cols.filter((c) => c !== pk);
    const updates = updateCols.map((c) => `${c}=excluded.${c}`).join(',');

    // No non-pk columns to update — skip the row.
    if (updates === '') continue;

    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT(${pk}) DO UPDATE SET ${updates}`;
    try {
      await pool.query(sql, cols.map((c) => row[c]));
      n++;
    } catch (err) {
      console.warn(`[sync] pull upsert ${table}#${row[pk]} failed:`, err.message);
    }
  }
  return n;
}

async function pullMenuTree() {
  // /api/menu/all → categories with nested subcategories[] and items[].
  // Flatten into three local tables.
  try {
    const r = await fetch(CLOUD_API_URL + '/api/menu/all', {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!r.ok) { console.warn(`[sync] pull /api/menu/all ${r.status}`); return []; }
    const categories = await r.json();
    if (!Array.isArray(categories)) return [];

    const flatCategories = categories.map((c) => ({
      id: c.id, name: c.name, sort_order: c.sort_order,
      is_bar: c.is_bar, default_course: c.default_course,
    }));
    const flatSubcategories = categories.flatMap((c) =>
      (c.subcategories || []).map((s) => ({
        id: s.id, category_id: s.category_id, name: s.name, sort_order: s.sort_order,
      }))
    );
    const flatItems = categories.flatMap((c) =>
      (c.items || []).map((i) => ({
        id: i.id, category_id: i.category_id, subcategory_id: i.subcategory_id,
        name: i.name, name_alt: i.name_alt, description: i.description,
        price: i.price, is_available: i.is_available,
        allergens: i.allergens, sort_order: i.sort_order,
      }))
    );

    const nCat   = await upsertRows('categories', 'id', flatCategories);
    const nSub   = await upsertRows('subcategories', 'id', flatSubcategories);
    const nItems = await upsertRows('menu_items', 'id', flatItems);
    console.log(`[sync] pull menu tree: ${nCat} cats, ${nSub} subs, ${nItems} items`);

    return flatItems.map((i) => i.id);
  } catch (err) {
    console.warn('[sync] pull menu tree failed:', err.message);
    return [];
  }
}

async function pullModifiersForMenuItems(itemIds) {
  // No bulk endpoint on Railway — fetch per item. The endpoint returns
  // [{ ...modifier_group, modifiers: [...modifier rows] }, ...]
  let totalGroups = 0;
  let totalMods = 0;
  for (const id of itemIds) {
    try {
      const r = await fetch(CLOUD_API_URL + `/api/menu/items/${id}/modifiers`, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const groups = await r.json();
      if (!Array.isArray(groups) || groups.length === 0) continue;

      const flatGroups = groups.map((g) => ({
        id: g.id, menu_item_id: g.menu_item_id ?? id,
        name: g.name, required: g.required, multi_select: g.multi_select,
      }));
      const flatMods = groups.flatMap((g) =>
        (g.modifiers || []).map((m) => ({
          id: m.id, group_id: m.group_id ?? g.id,
          name: m.name, extra_price: m.extra_price, is_available: m.is_available,
        }))
      );
      totalGroups += await upsertRows('modifier_groups', 'id', flatGroups);
      totalMods   += await upsertRows('modifiers', 'id', flatMods);
    } catch (err) {
      console.warn(`[sync] modifiers item#${id} failed:`, err.message);
    }
  }
  if (totalGroups || totalMods) {
    console.log(`[sync] pull modifiers: ${totalGroups} groups, ${totalMods} options`);
  }
}

async function pullFromCloud() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;

  // Flat-shape endpoints.
  for (const ep of PULL_TABLES) {
    try {
      const r = await fetch(CLOUD_API_URL + ep.path, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!r.ok) {
        console.warn(`[sync] pull ${ep.path} ${r.status}`);
        continue;
      }
      const rows = await r.json();
      const list = Array.isArray(rows) ? rows : (rows?.data || []);
      const n = await upsertRows(ep.table, ep.pk, list);
      if (n > 0) console.log(`[sync] pull ${ep.table}: ${n} rows`);
    } catch (err) {
      console.warn(`[sync] pull ${ep.path} failed:`, err.message);
    }
  }

  // Nested menu tree + modifier subtree.
  const itemIds = await pullMenuTree();
  if (itemIds.length > 0) {
    await pullModifiersForMenuItems(itemIds);
  }

  // Closed orders + items + payments — gated by SYNC_SECRET.
  await pullClosedOrders();

  // Active (open) orders + items + payments — also gated by SYNC_SECRET.
  // Enables bidirectional sync: orders Chrome creates now show up on the Mac.
  await pullActiveOrders();
}

// SEPOS-PRO-002 — pull open orders + items from the cloud and mirror locally.
// Conflict rule: cloud-wins for matched rows. New cloud rows insert with a
// fresh local id but carry their cloud_id so future pushes don't double up.
// Items whose parent order isn't found locally are skipped — the order will
// be inserted first on the next tick, then the items follow.
async function pullActiveOrders() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;
  if (!process.env.SYNC_SECRET) return;

  let payload;
  try {
    const r = await fetch(`${CLOUD_API_URL}/api/sync/active-orders`, {
      headers: { 'x-sync-secret': process.env.SYNC_SECRET },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS * 2),
    });
    if (!r.ok) { console.warn(`[sync] active-orders pull ${r.status}`); return; }
    payload = await r.json();
  } catch (err) {
    console.warn('[sync] active-orders pull failed:', err.message);
    return;
  }

  const { orders = [], order_items = [], payments = [] } = payload;
  if (orders.length === 0) return;

  let inserted = 0, updated = 0;

  // ─── Orders ───────────────────────────────────────────────────────
  // For each cloud order, either UPDATE the local row that already has
  // this cloud_id, or INSERT a new local row carrying the cloud_id.
  const orderColsRow = await pool.query('PRAGMA table_info(orders)');
  const orderCols = orderColsRow.rows.map(r => r.name);
  for (const cloudOrder of orders) {
    const cloudId = cloudOrder.id;
    if (!cloudId) continue;
    let localId = await findLocalOrderByCloudId(cloudId);

    // Migration safety: this is the first run since cloud_id columns landed,
    // so existing local orders won't be bound to their cloud rows yet. Try a
    // (table_id, opened_at) reconciliation before deciding to INSERT, so we
    // don't duplicate orders that were pushed under the old in-memory map.
    if (!localId && cloudOrder.table_id != null && cloudOrder.opened_at) {
      const probe = await pool.query(
        `SELECT id FROM orders
         WHERE cloud_id IS NULL
           AND status = 'open'
           AND table_id = $1
           AND ABS((julianday(opened_at) - julianday($2)) * 86400) < 120
         LIMIT 1`,
        [cloudOrder.table_id, cloudOrder.opened_at]
      );
      if (probe.rows[0]?.id) {
        localId = probe.rows[0].id;
        await setOrderCloudId(localId, cloudId);
      }
    }

    // Build a column→value map of fields that exist in the local schema,
    // dropping the cloud's `id` (we use our own auto-id locally) and any
    // null/undefined that would clobber a meaningful local value.
    const fields = {};
    for (const [k, v] of Object.entries(cloudOrder)) {
      if (k === 'id') continue;
      if (!orderCols.includes(k)) continue;
      if (v === null || v === undefined) continue;
      fields[k] = v;
    }
    fields.cloud_id = cloudId;

    if (localId) {
      const setCols = Object.keys(fields).filter(k => k !== 'cloud_id');
      if (setCols.length > 0) {
        const sets = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
        await pool.query(
          `UPDATE orders SET ${sets} WHERE id = $${setCols.length + 1}`,
          [...setCols.map(c => fields[c]), localId]
        );
        updated++;
      }
    } else {
      const cols = Object.keys(fields);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(
        `INSERT INTO orders (${cols.join(',')}) VALUES (${placeholders})`,
        cols.map(c => fields[c])
      );
      inserted++;
    }
  }

  // ─── Order items ──────────────────────────────────────────────────
  const itemColsRow = await pool.query('PRAGMA table_info(order_items)');
  const itemCols = itemColsRow.rows.map(r => r.name);
  let itemsInserted = 0, itemsUpdated = 0, itemsSkipped = 0;
  for (const cloudItem of order_items) {
    const cloudId = cloudItem.id;
    if (!cloudId) continue;
    // Translate cloud order_id → local order_id.
    const localOrderId = await findLocalOrderByCloudId(cloudItem.order_id);
    if (!localOrderId) { itemsSkipped++; continue; }

    const localItemId = await findLocalItemByCloudId(cloudId);
    const fields = { order_id: localOrderId };
    for (const [k, v] of Object.entries(cloudItem)) {
      if (k === 'id' || k === 'order_id') continue;
      if (!itemCols.includes(k)) continue;
      if (v === null || v === undefined) continue;
      fields[k] = v;
    }
    fields.cloud_id = cloudId;

    if (localItemId) {
      const setCols = Object.keys(fields).filter(k => k !== 'cloud_id');
      if (setCols.length > 0) {
        const sets = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
        await pool.query(
          `UPDATE order_items SET ${sets} WHERE id = $${setCols.length + 1}`,
          [...setCols.map(c => fields[c]), localItemId]
        );
        itemsUpdated++;
      }
    } else {
      const cols = Object.keys(fields);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(
        `INSERT INTO order_items (${cols.join(',')}) VALUES (${placeholders})`,
        cols.map(c => fields[c])
      );
      itemsInserted++;
    }
  }

  if (inserted || updated || itemsInserted || itemsUpdated) {
    console.log(`[sync] active-orders: ${inserted}+${updated} orders, ${itemsInserted}+${itemsUpdated} items${itemsSkipped ? ` (${itemsSkipped} item-skips, parent not yet pulled)` : ''}`);
  }
}

// SEPOS — pull closed orders + items + payments from the cloud.
// Paginated by closed_at; the last seen timestamp is persisted in
// sync_state so subsequent ticks only pull the delta.
async function readSyncState(key) {
  try {
    const r = await pool.query('SELECT value FROM sync_state WHERE key = $1', [key]);
    return r.rows[0]?.value || null;
  } catch { return null; }
}
async function writeSyncState(key, value) {
  try {
    // SQLite UPSERT — works in both PG and SQLite since 3.24.
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [key, value]
    );
  } catch (err) { console.warn('[sync] writeSyncState failed:', err.message); }
}

async function pullClosedOrders() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;
  if (!process.env.SYNC_SECRET) {
    // Without a shared secret the server-side feed refuses; skip quietly.
    return;
  }
  let since = (await readSyncState('closed_orders_since')) || '1970-01-01';
  let pulled = 0;
  for (let safety = 0; safety < 200; safety++) {  // hard cap to avoid runaway
    let payload;
    try {
      const r = await fetch(`${CLOUD_API_URL}/api/sync/closed-orders?since=${encodeURIComponent(since)}&limit=500`, {
        headers: { 'x-sync-secret': process.env.SYNC_SECRET },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS * 2),
      });
      if (!r.ok) {
        console.warn(`[sync] closed-orders pull ${r.status}`);
        return;
      }
      payload = await r.json();
    } catch (err) {
      console.warn('[sync] closed-orders pull failed:', err.message);
      return;
    }

    const { orders = [], order_items = [], payments = [], max_closed_at, has_more } = payload;
    if (orders.length === 0) break;

    // Upsert in FK-friendly order: orders first (parents), then items + payments.
    await upsertRows('orders',      'id', orders);
    await upsertRows('order_items', 'id', order_items);
    await upsertRows('payments',    'id', payments);
    pulled += orders.length;

    since = max_closed_at;
    await writeSyncState('closed_orders_since', String(since));
    if (!has_more) break;
  }
  if (pulled > 0) console.log(`[sync] closed-orders: ${pulled} pulled`);
}

async function isMenuEmpty() {
  try {
    const r = await pool.query('SELECT COUNT(*) AS n FROM menu_items');
    return Number(r.rows[0]?.n || 0) === 0;
  } catch { return true; }
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
  if (inProgress) return;
  inProgress = true;
  try {
    const online = await ping();
    if (!online) {
      setStatus('local');
      return;
    }

    // First-launch full sync — show the banner while it runs so the operator
    // sees something is happening instead of an empty menu.
    if (!initialSyncDone) {
      const empty = await isMenuEmpty();
      if (empty) {
        setStatus('initial-sync');
        await pullFromCloud();
        initialSyncDone = true;
        const remaining = await offlineQueue.pendingCount();
        setStatus(remaining > 0 ? 'syncing' : 'cloud');
        return;
      }
      initialSyncDone = true;
    }

    await syncOnce();
    await pullFromCloud();
    const remaining = await offlineQueue.pendingCount();
    setStatus(remaining > 0 ? 'syncing' : 'cloud');
  } finally {
    inProgress = false;
  }
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

module.exports = { start, stop, getStatus, onStatusChange, syncOnce, pullFromCloud, pullClosedOrders, pullActiveOrders, tick };
