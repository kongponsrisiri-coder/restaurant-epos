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

module.exports = { start, stop, getStatus, onStatusChange, syncOnce, pullFromCloud, tick };
