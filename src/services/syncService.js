// Phase 3 sync engine (push-only). Pings Railway every 30s; when reachable,
// drains sync_queue into the cloud API. Cloud → local pull and full conflict
// resolution remain for Phase 4.
//
// CLOUD_API_URL env var controls the target. If unset, sync stays in local
// mode permanently (queue grows but nothing pushes — safe default for tests).

const offlineQueue = require('./offlineQueue');
const pool = require('../db/dbAdapter');

const CLOUD_API_URL = process.env.CLOUD_API_URL || '';
// Default 5s — feels real-time for Mac↔Chrome floor-map flows. Override
// per install via SYNC_PING_MS env var if you need to dial back (e.g.
// multi-tenant deployments approaching Railway's egress quota).
const PING_INTERVAL_MS = parseInt(process.env.SYNC_PING_MS || '5000', 10);
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
  // orphan: true — a table/wall deleted on the cloud must ALSO delete locally,
  // or it lingers as a ghost on the till's floor forever (pull was upsert-only;
  // found live on Baan Siam 2026-08-05: cloud-deleted test table never left the
  // local plan). Safe now that plan writes are strict write-through — a row
  // can't exist locally without the cloud knowing about it.
  { path: '/api/tables',                 table: 'tables',                 pk: 'id', orphan: true },
  // SEPOS-047k — staff is pulled separately via the SYNC_SECRET-gated
  // /api/sync/staff feed (pullStaff), because the public /api/staff omits
  // pin and local staff.pin is NOT NULL. See pullStaff() below.
  { path: '/api/settings',               table: 'settings',               pk: 'key' },
  { path: '/api/table-walls',            table: 'table_walls',            pk: 'id', orphan: true },
  { path: '/api/table-combinations',     table: 'table_combinations',     pk: 'id', orphan: true },
  { path: '/api/dining-duration-tiers',  table: 'dining_duration_tiers',  pk: 'id' },
  { path: '/api/reservations',           table: 'reservations',           pk: 'id' },
  // SEPOS-049 — reservation/takeaway hours, party limits, wait-time tiers
  // and brand colour all live here. Without pull, desktop saves never see
  // cloud edits (and vice versa via the write-through on the PUT endpoint).
  { path: '/api/restaurant-settings',    table: 'restaurant_settings',    pk: 'restaurant_id' },
  // SEPOS-046k — Inventory + Batch-Prep config/state. Cloud is authoritative
  // for editing (operator works in web admin); desktop pulls read-only so
  // the till can show ingredients, recipes, and active batches. Ordered
  // parents-first so SQLite FK constraints (when enforced) don't reject
  // children before their parent row lands. Stock_movements is intentionally
  // NOT here — high-volume log; bidirectional push for desktop-side sales
  // depletion deferred to SEPOS-046l.
  { path: '/api/ingredients',            table: 'ingredients',            pk: 'id' },
  { path: '/api/supplier-invoices',      table: 'supplier_invoices',      pk: 'id' },
  { path: '/api/batch-recipes',          table: 'batch_recipes',          pk: 'id' },
  { path: '/api/batch-recipe-lines',     table: 'batch_recipe_lines',     pk: 'id' },
  { path: '/api/batches',                table: 'batches',                pk: 'id' },
  { path: '/api/recipes',                table: 'recipes',                pk: 'id' },
  { path: '/api/recipe-lines',           table: 'recipe_lines',           pk: 'id' },
  // SEPOS-059 — shared modifier library. Pull modifier_groups (incl. shared
  // NULL-menu_item_id groups), all options, and the dish↔group join as flat
  // cloud-wins tables so the till resolves item modifiers identically to the
  // cloud. Replaces the old per-item modifier pull (which lost a shared group
  // on all but the last dish it was attached to).
  { path: '/api/modifier-groups-all',        table: 'modifier_groups',           pk: 'id', orphan: true },
  { path: '/api/modifiers-all',              table: 'modifiers',                 pk: 'id', orphan: true },
  { path: '/api/menu-item-modifier-groups',  table: 'menu_item_modifier_groups', pk: 'id', orphan: true },
  // SEPOS-046ac — Cost & Sales expenses, same cloud-authoritative pull as
  // the rest of the inventory family.
  { path: '/api/expenses',               table: 'expenses',               pk: 'id' },
  // SEPOS-053 — till trading sessions. Cloud→desktop so a shift opened on
  // another terminal shows on this till's banner; desktop-initiated open/close
  // forwards to cloud first (forwardWriteToCloud) so ids stay in one space.
  { path: '/api/till-sessions',          table: 'till_sessions',          pk: 'id' },
  // SEPOS-AUDIT-001 (verify pass) — vouchers became cloud-authoritative
  // (redeem/sell forward to the cloud), which emptied the till's LOCAL voucher
  // tables and blanked the Z's voucher figures — including the drawer
  // reconciliation for cash voucher sales. Mirror both tables cloud→local so
  // the reports see them again. UPSERT-ONLY (no orphan-delete): the cloud
  // feeds are windowed/LIMIT'd and a voucher sold OFFLINE lives only locally
  // until its sell_voucher push lands — orphan-delete would wipe both.
  // Voids arrive as status='void' updates on the matched id, so hard-delete
  // reconciliation isn't needed.
  { path: '/api/vouchers',               table: 'vouchers',               pk: 'id' },
  { path: '/api/voucher-redemptions',    table: 'voucher_redemptions',    pk: 'id' },
];

// SEPOS-DEVICE-PRINTERS-001 — device-owned settings the cloud-wins pull must NOT
// overwrite. These name THIS till's physical print hardware / LAN, or reference
// rows in the device-local `printers` table (which is already not synced). The
// cloud copy belongs to whichever till last pushed (or stale onboarding), so
// letting it cloud-win silently reverts a working printer setup mid-service —
// the till is authoritative for its own hardware. (Local edits still PUSH to the
// cloud as a backup; we just never let the cloud pull clobber them back.)
const DEVICE_OWNED_SETTING_PREFIXES = ['printer_'];
const DEVICE_OWNED_SETTING_KEYS = new Set([
  'default_receipt_printer_id', 'default_kitchen_printer_id', 'default_bar_printer_id',
  'open_drawer_on_payment', 'kitchen_thai_codepage',
]);
function isDeviceOwnedSettingKey(key) {
  const k = String(key);
  return DEVICE_OWNED_SETTING_PREFIXES.some((p) => k.startsWith(p)) || DEVICE_OWNED_SETTING_KEYS.has(k);
}

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

// "Pending mutations" guard. While a local change is sitting in sync_queue
// waiting to push, Mac is authoritative for that order. If we pull cloud
// state and overwrite, the user sees the change appear and then snap back
// (cloud hadn't yet received the push). Pull must skip these rows until
// the push completes and clears the queue entry.
async function ordersWithPendingPush() {
  try {
    // SEPOS-AUDIT-001 — every order-scoped action type must be listed here,
    // or the cloud-wins pull reverts the local change while its push is still
    // in the queue (the revert class the stability audit confirmed).
    const r = await pool.query(
      `SELECT payload FROM sync_queue WHERE synced = 0
       AND action_type IN ('create_order','add_items','fire_course','pay_order','delete_order',
                           'apply_discount','update_order_flags','move_order','merge_orders',
                           'resend_items','close_zero','cancel_order','takeaway_status',
                           'amend_method','edit_payment')`
    );
    const orderIds = new Set();
    for (const row of r.rows) {
      try {
        const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (p && p.localOrderId) orderIds.add(Number(p.localOrderId));
        // merge_orders touches TWO orders — protect the source too.
        if (p && p.mergeLocalOrderId) orderIds.add(Number(p.mergeLocalOrderId));
      } catch {}
    }
    return orderIds;
  } catch { return new Set(); }
}
// Cloud ids that are currently being deleted via the sync push queue.
// Used by pullActiveOrders to avoid re-INSERTing an order locally between
// the local delete and the cloud delete completing.
async function cloudIdsWithPendingDelete() {
  try {
    const r = await pool.query(
      `SELECT payload FROM sync_queue WHERE synced = 0 AND action_type = 'delete_order'`
    );
    const cloudIds = new Set();
    for (const row of r.rows) {
      try {
        const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (p && p.cloudOrderId) cloudIds.add(Number(p.cloudOrderId));
      } catch {}
    }
    return cloudIds;
  } catch { return new Set(); }
}
async function itemsWithPendingPush() {
  try {
    const r = await pool.query(
      `SELECT payload FROM sync_queue WHERE synced = 0
       AND action_type IN ('add_items','void_item','update_item_status',
                           'apply_item_discount','resend_items','merge_orders')`
    );
    const itemIds = new Set();
    for (const row of r.rows) {
      try {
        const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (p && p.localItemId) itemIds.add(Number(p.localItemId));
        if (p && Array.isArray(p.items)) {
          for (const it of p.items) {
            if (it && it.localItemId) itemIds.add(Number(it.localItemId));
          }
        }
        // resend_items carries a plain array of local item ids.
        if (p && Array.isArray(p.localItemIds)) {
          for (const id of p.localItemIds) itemIds.add(Number(id));
        }
      } catch {}
    }
    return itemIds;
  } catch { return new Set(); }
}

// SEPOS-AUDIT-001 — is there still an unsynced queue entry of one of these
// action types for this local order/item? Used by the strict cloud-id
// resolvers below to tell "parent push hasn't run yet" (transient — wait)
// apart from "parent push failed/was quarantined" (permanent — never target
// the cloud with a raw local id).
async function hasPendingQueueAction(actionTypes, matcher) {
  try {
    const placeholders = actionTypes.map((_, i) => `$${i + 1}`).join(',');
    const r = await pool.query(
      `SELECT payload FROM sync_queue WHERE synced = 0 AND action_type IN (${placeholders})`,
      actionTypes
    );
    for (const row of r.rows) {
      try {
        const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (p && matcher(p)) return true;
      } catch {}
    }
    return false;
  } catch { return false; }
}

// SEPOS-AUDIT-001 — CRITICAL fix. The push cases below used to fall back to
// the RAW LOCAL id when cloud_id wasn't bound (`|| payload.localOrderId`).
// Local ids and cloud ids are independent sequences, so when a create_order
// push failed permanently (quarantined) that fallback made add_items / pay /
// fire / void target whatever UNRELATED cloud order happened to share the
// number — items landed on and payments CLOSED someone else's live bill.
// SEPOS-047c removed exactly this fallback for delete_order; these resolvers
// extend the same refusal to every other cloud mutation:
//   • cloud_id bound → use it.
//   • unbound but the parent create/add push is still pending → throw a
//     plain error (no HTTP status → classified transient → retried next
//     tick, by which time the ordered drain has bound the id).
//   • unbound with no pending parent → the parent push is gone (quarantined/
//     lost). Throw err.permanent so the entry is quarantined too and
//     surfaced in the Sync-queue modal, instead of hitting a wrong bill.
async function requireOrderCloudId(actionType, localOrderId) {
  const cloudId = await getOrderCloudId(localOrderId);
  if (cloudId) return cloudId;
  const parentPending = await hasPendingQueueAction(['create_order'],
    (p) => Number(p.localOrderId) === Number(localOrderId));
  if (parentPending) {
    throw new Error(`${actionType}: waiting for create_order push of local order ${localOrderId}`);
  }
  const err = new Error(
    `${actionType}: local order ${localOrderId} has no cloud_id and no pending create_order — refusing to target a raw local id on the cloud`);
  err.permanent = true;
  throw err;
}
async function requireItemCloudId(actionType, localItemId) {
  const cloudId = await getItemCloudId(localItemId);
  if (cloudId) return cloudId;
  const parentPending = await hasPendingQueueAction(['add_items', 'create_order'],
    (p) => (Array.isArray(p.items) && p.items.some(it => Number(it?.localItemId) === Number(localItemId)))
        || Number(p.localItemId) === Number(localItemId));
  if (parentPending) {
    throw new Error(`${actionType}: waiting for add_items push of local item ${localItemId}`);
  }
  const err = new Error(
    `${actionType}: local item ${localItemId} has no cloud_id and no pending add_items — refusing to target a raw local id on the cloud`);
  err.permanent = true;
  throw err;
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
      // SEPOS-047f — forward staff_id + order_type too. Without them the
      // cloud defaulted every pushed order to order_type='dine_in',
      // staff_id NULL, so counter/takeaway orders lost their 🥡 flow and
      // staff attribution — and the corruption round-tripped: the next
      // pullActiveOrders cloud-wins UPDATE flipped the LOCAL row to dine_in.
      const r = await fetch(url('/api/orders'), {
        method: 'POST', ...json({
          table_id:   payload.table_id,
          covers:     payload.covers,
          staff_id:   payload.staff_id,
          order_type: payload.order_type,
        }),
      });
      if (!r.ok) throw new Error(`create_order ${r.status}`);
      const j = await r.json();
      if (payload.localOrderId && j?.id) {
        await setOrderCloudId(payload.localOrderId, j.id);
      }
      return j;
    }
    case 'add_items': {
      const cloudId = await requireOrderCloudId('add_items', payload.localOrderId);
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
      const cloudId = await requireOrderCloudId('pay_order', payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/pay`), {
        // SEPOS-062 — forward the per-tender split breakdown when present so the
        // cloud records the same Cash/Card rows the till did.
        method: 'POST', ...json(payload.payments
          ? { payments: payload.payments }
          : { amount: payload.amount, method: payload.method }),
      });
      if (!r.ok) throw new Error(`pay_order ${r.status}`);
      return r.json();
    }
    case 'fire_course': {
      const cloudId = await requireOrderCloudId('fire_course', payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/fire-course/${payload.course}`), {
        method: 'PUT', ...json({}),
      });
      if (!r.ok) throw new Error(`fire_course ${r.status}`);
      return r.json();
    }
    case 'void_item': {
      const cloudItemId = await requireItemCloudId('void_item', payload.localItemId);
      // SEPOS-047c — forward quantity + void_type so the cloud voids the
      // SAME amount (was {reason} only → cloud voided the WHOLE line).
      const r = await fetch(url(`/api/order-items/${cloudItemId}/void`), {
        method: 'PUT', ...json({
          reason: payload.reason,
          quantity: payload.quantity,
          void_type: payload.void_type ?? null,
        }),
      });
      if (!r.ok) throw new Error(`void_item ${r.status}`);
      const j = await r.json();
      // Bind the local partial-void ghost to the cloud ghost so the next
      // pullActiveOrders UPDATEs it instead of INSERTing a second ghost
      // (which would double-count the voided quantity locally).
      if (payload.ghostLocalId && j?.ghost_item_id) {
        await setItemCloudId(payload.ghostLocalId, j.ghost_item_id);
      }
      return j;
    }
    case 'update_item_status': {
      // Pass tap "Done" / chef tap "Cooked" on a local-mode install.
      // Mirror the change to cloud so the next pullActiveOrders doesn't
      // revert it. If cloud_id isn't bound yet (item created here this tick,
      // push not yet completed) the resolver throws a transient error so the
      // ordered drain binds it first — never a raw-local-id fallback.
      const cloudItemId = await requireItemCloudId('update_item_status', payload.localItemId);
      const r = await fetch(url(`/api/order-items/${cloudItemId}/status`), {
        method: 'PUT', ...json({ status: payload.status }),
      });
      if (!r.ok) throw new Error(`update_item_status ${r.status}`);
      return r.json();
    }
    case 'update_kv_settings': {
      // SEPOS-049 part-2 — drain KV settings push (printer_*, delivery_*,
      // kitchen_print_mode, service_charge_*, etc). Idempotent: server
      // upserts by key, so replay after a successful immediate-push is
      // harmless. PUT /api/settings is SYNC_SECRET-gated on the cloud — send
      // the header; if SYNC_SECRET isn't configured yet, throw so the queue
      // retries once it is (rather than 401-failing into a dropped change).
      if (!process.env.SYNC_SECRET) {
        console.warn('[sync] update_kv_settings: SYNC_SECRET not configured — settings push will retry once it is set');
        throw new Error('SYNC_SECRET missing');
      }
      const r = await fetch(url('/api/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
        body: JSON.stringify(payload.updates || {}),
      });
      if (!r.ok) throw new Error(`update_kv_settings ${r.status}`);
      return r.json();
    }
    case 'update_restaurant_settings': {
      // SEPOS-050 — durable settings push. Forwards the PUT body that
      // the operator saved on the desktop. Idempotent: PG ON CONFLICT
      // overwrites, so a duplicate replay (immediate-push succeeded then
      // drain replays) is harmless. URL-encodes the restaurant id since
      // it's user-tunable text, not a numeric.
      const r = await fetch(url(`/api/reservations/settings/${encodeURIComponent(payload.restaurantId)}`), {
        method: 'PUT', ...json(payload.body),
      });
      if (!r.ok) throw new Error(`update_restaurant_settings ${r.status}`);
      return r.json();
    }
    case 'delete_order': {
      // The local row is already gone (delete happened before enqueue),
      // so we use the cloudOrderId captured in the payload. Cloud-side
      // endpoint is SYNC_SECRET-gated — the manager PIN was already
      // validated on the Mac before this got queued.
      // SEPOS-047c — use ONLY the cloud id; never the local id (deleting
      // by local id hits a different cloud order). null → the order never
      // reached the cloud, so there's nothing to delete there.
      const cloudId = payload.cloudOrderId;
      // Fallback match keys for when cloud_id was never bound — see the enqueue
      // in DELETE /api/orders/:id. Without these an unbound delete used to skip
      // the cloud entirely, orphaning the cloud copy so the pull kept re-seeding
      // it (the zombie-table bug).
      const canMatch = payload.matchTableId != null && payload.matchOpenedAt;
      if (!cloudId && !canMatch) {
        console.warn(`[sync] delete_order: local order ${payload.localOrderId} had no cloud_id and no match keys — skipping cloud delete`);
        return { skipped: true, reason: 'no cloud id or match keys' };
      }
      if (!process.env.SYNC_SECRET) {
        // Throw so the queue entry stays pending and retries — the moment
        // SYNC_SECRET is configured (Mac config.json or env), the next
        // tick will drain the backlog. Throttle the warning so we don't
        // spam the log every 5s.
        const now = Date.now();
        if (!_lastWarnedSecret || now - _lastWarnedSecret > 60_000) {
          console.warn('[sync] delete_order: SYNC_SECRET not configured — delete will retry once it is set');
          _lastWarnedSecret = now;
        }
        throw new Error('SYNC_SECRET missing');
      }
      const r = await fetch(url('/api/sync/delete-order'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
        body: JSON.stringify({
          order_id:   cloudId || null,
          // Only sent when cloud_id is missing — the cloud resolves the open
          // order by table + open-time instead of giving up.
          match:      cloudId ? null : { table_id: payload.matchTableId, opened_at: payload.matchOpenedAt },
          staff_name: payload.staff_name,
          staff_role: payload.staff_role,
          reason:     payload.reason,
        }),
      });
      if (!r.ok) throw new Error(`delete_order ${r.status}`);
      return r.json();
    }
    // ── SEPOS-AUDIT-001 — push cases for the writes that used to be one-way ──
    // (local till applied them, nothing pushed, and the 5s cloud-wins pull
    // reverted them). Each replays the SAME public endpoint on the cloud with
    // the local ids translated to cloud ids.
    case 'apply_discount': {
      const cloudId = await requireOrderCloudId('apply_discount', payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/discount`), {
        method: 'PUT', ...json({
          discount_type: payload.discount_type,
          discount_value: payload.discount_value,
          discount_reason: payload.discount_reason,
        }),
      });
      if (!r.ok) throw new Error(`apply_discount ${r.status}`);
      return r.json();
    }
    case 'apply_item_discount': {
      const cloudItemId = await requireItemCloudId('apply_item_discount', payload.localItemId);
      const r = await fetch(url(`/api/order-items/${cloudItemId}/discount`), {
        method: 'PUT', ...json({
          discount_type: payload.discount_type,
          discount_value: payload.discount_value,
        }),
      });
      if (!r.ok) throw new Error(`apply_item_discount ${r.status}`);
      return r.json();
    }
    case 'update_order_flags': {
      const cloudId = await requireOrderCloudId('update_order_flags', payload.localOrderId);
      if (payload.no_service_charge !== undefined && payload.no_service_charge !== null) {
        const r = await fetch(url(`/api/orders/${cloudId}/service-charge`), {
          method: 'PUT', ...json({ no_service_charge: payload.no_service_charge }),
        });
        if (!r.ok) throw new Error(`update_order_flags(service-charge) ${r.status}`);
      }
      if (payload.bill_printed) {
        const r = await fetch(url(`/api/orders/${cloudId}/bill-printed`), {
          method: 'PUT', ...json({}),
        });
        if (!r.ok) throw new Error(`update_order_flags(bill-printed) ${r.status}`);
      }
      return { ok: true };
    }
    case 'move_order': {
      const cloudId = await requireOrderCloudId('move_order', payload.localOrderId);
      // Table ids are shared cloud/local (the tables pull keeps cloud pks).
      const r = await fetch(url(`/api/orders/${cloudId}/move`), {
        method: 'PUT', ...json({ new_table_id: payload.new_table_id }),
      });
      if (!r.ok) throw new Error(`move_order ${r.status}`);
      return r.json();
    }
    case 'merge_orders': {
      const cloudTarget = await requireOrderCloudId('merge_orders', payload.localOrderId);
      const cloudSource = await requireOrderCloudId('merge_orders', payload.mergeLocalOrderId);
      const r = await fetch(url(`/api/orders/${cloudTarget}/merge`), {
        method: 'PUT', ...json({ merge_order_id: cloudSource }),
      });
      if (!r.ok) throw new Error(`merge_orders ${r.status}`);
      return r.json();
    }
    case 'resend_items': {
      const cloudId = await requireOrderCloudId('resend_items', payload.localOrderId);
      const cloudItemIds = [];
      for (const localItemId of payload.localItemIds || []) {
        cloudItemIds.push(await requireItemCloudId('resend_items', localItemId));
      }
      if (cloudItemIds.length === 0) return { skipped: true };
      const r = await fetch(url(`/api/orders/${cloudId}/resend`), {
        method: 'POST', ...json({ item_ids: cloudItemIds, reason: payload.reason }),
      });
      if (!r.ok) throw new Error(`resend_items ${r.status}`);
      return r.json();
    }
    case 'close_zero': {
      const cloudId = await requireOrderCloudId('close_zero', payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/close-zero`), { method: 'POST', ...json({}) });
      // 409 = already closed on cloud (someone else closed it) — done.
      if (r.status === 409) return { alreadyClosed: true };
      if (!r.ok) throw new Error(`close_zero ${r.status}`);
      return r.json();
    }
    case 'cancel_order': {
      const cloudId = await requireOrderCloudId('cancel_order', payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/pay`), {
        method: 'POST', ...json({ amount: 0, method: 'cancelled' }),
      });
      if (r.status === 409) return { alreadyClosed: true };
      if (!r.ok) throw new Error(`cancel_order ${r.status}`);
      return r.json();
    }
    case 'takeaway_status': {
      const cloudId = await requireOrderCloudId('takeaway_status', payload.localOrderId);
      const r = await fetch(url(`/api/orders/${cloudId}/takeaway-status`), {
        method: 'PUT', ...json({ status: payload.status }),
      });
      if (!r.ok) throw new Error(`takeaway_status ${r.status}`);
      return r.json();
    }
    case 'amend_method': {
      // Verify pass — replays through the SYNC_SECRET-gated sync endpoint so
      // no PIN is ever persisted in sync_queue (the PIN was already validated
      // on the till at request time).
      const cloudId = await requireOrderCloudId('amend_method', payload.localOrderId);
      if (!process.env.SYNC_SECRET) throw new Error('SYNC_SECRET missing');
      const r = await fetch(url('/api/sync/amend-method'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
        body: JSON.stringify({
          order_id: cloudId, new_method: payload.new_method,
          reason: payload.reason, amended_by_name: payload.amended_by_name,
          // legacy entries queued before this change carried a pin — ignored.
        }),
      });
      if (!r.ok) throw new Error(`amend_method ${r.status}`);
      return r.json();
    }
    case 'edit_payment': {
      const cloudId = await requireOrderCloudId('edit_payment', payload.localOrderId);
      if (!process.env.SYNC_SECRET) throw new Error('SYNC_SECRET missing');
      const r = await fetch(url('/api/sync/edit-payment'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
        body: JSON.stringify({
          order_id: cloudId, edits: payload.edits,
          reason: payload.reason, amended_by_name: payload.amended_by_name,
          sync_key: payload.sync_key || null, // verify pass — replay idempotency
        }),
      });
      if (!r.ok) throw new Error(`edit_payment ${r.status}`);
      return r.json();
    }
    case 'sell_voucher': {
      // Verify pass — replay an offline voucher sale with the SAME code the
      // customer holds. Idempotent (ON CONFLICT(code) DO NOTHING on the cloud).
      if (!process.env.SYNC_SECRET) throw new Error('SYNC_SECRET missing');
      const r = await fetch(url('/api/sync/sell-voucher'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`sell_voucher ${r.status}`);
      return r.json();
    }
    case 'session_open': {
      const r = await fetch(url('/api/till-sessions/open'), {
        method: 'POST', ...json({ staff_id: payload.staff_id, float_amount: payload.float_amount }),
      });
      if (r.status === 409) return { alreadyOpen: true };   // cloud already has an open shift
      if (!r.ok) throw new Error(`session_open ${r.status}`);
      return r.json();
    }
    case 'session_close': {
      const r = await fetch(url('/api/till-sessions/close'), {
        method: 'POST', ...json({ closed_by: payload.closed_by, z_report_id: payload.z_report_id }),
      });
      if (r.status === 409) return { alreadyClosed: true }; // no open shift on cloud — done
      if (!r.ok) throw new Error(`session_close ${r.status}`);
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

async function upsertRows(table, pk, rows, nullableCols = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const localCols = await getLocalColumns(table);
  if (localCols.length === 0) return 0;

  let n = 0;
  for (const row of rows) {
    // Build the column list per row, dropping null/undefined cloud values so
    // they don't clobber non-null local defaults (e.g. staff.is_active=1 from
    // the seed when cloud returns is_active=null, or pin which cloud never
    // sends at all but local needs to keep).
    // EXCEPTION — columns listed in `nullableCols` sync even when the cloud
    // value is null, so a DELIBERATELY cleared value actually clears locally
    // instead of sticking forever. This is what makes un-assigning a category
    // → printer route work on desktop (SEPOS-PRINT-002 flexible multi-station
    // routing): remove the route in the till → cloud printer_id = null → this
    // now propagates the null down. `undefined` (a field the cloud never sends)
    // is still always dropped — only an explicit null on an opted-in column
    // clears.
    const cols = Object.keys(row).filter((c) => {
      if (!localCols.includes(c) || row[c] === undefined) return false;
      if (row[c] === null) return nullableCols.includes(c);
      return true;
    });
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

// SEPOS-046p — given a flat table and the set of IDs that exist on the
// cloud, delete every local row whose id is NOT in that set. Used by
// pullMenuTree() to keep local menu in sync with cloud deletions.
// Returns the count of rows deleted.
async function deleteOrphans(table, cloudIds) {
  try {
    const localRes = await pool.query(`SELECT id FROM ${table}`);
    const cloudSet = new Set(cloudIds.map(Number));
    const localIds = localRes.rows.map(r => Number(r.id));
    const orphanIds = localIds.filter(id => !cloudSet.has(id));
    if (orphanIds.length === 0) return 0;
    for (const id of orphanIds) {
      try {
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      } catch (err) {
        console.warn(`[sync] delete orphan ${table}#${id} failed:`, err.message);
      }
    }
    return orphanIds.length;
  } catch (err) {
    console.warn(`[sync] deleteOrphans ${table} failed:`, err.message);
    return 0;
  }
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
      // SEPOS-047i (same bug class as the item fields below): printer_id was
      // omitted here, so a per-category station assignment made on the till —
      // "Sends: <category> → this printer" — was forwarded to cloud, pulled
      // back, but never landed in local categories.printer_id. The desktop
      // print router JOINs the LOCAL categories.printer_id (server.js kitchen/
      // bar split + takeaway auto-router), so multi-station routing (sushi /
      // starter / hot / bar printers) silently reverted on every local refetch
      // and the category "wouldn't stay" in the UI. NOTE: upsertRows drops null
      // values, so UN-assigning (printer_id → null) still won't clear locally
      // until a full re-pull — same known limitation as the sibling item fields.
      printer_id: c.printer_id,
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
        // SEPOS-047i — vat_rate + is_online were omitted from this projection,
        // so a VAT-rate change made on the till (forwarded to cloud, then
        // pulled back) never landed in local menu_items. The desktop bill
        // VAT breakdown, Z-report VAT and VAT report all JOIN the LOCAL
        // menu_items.vat_rate, so receipts + HMRC-facing figures used the
        // stale rate forever. is_online (takeaway-widget visibility) had the
        // same drop — the toggle reverted on the next local refetch.
        vat_rate: i.vat_rate, is_online: i.is_online,
        // Same bug class as vat_rate above: the per-item kitchen course
        // override (7437041, v1.6.115) never reached local-mode tills, so
        // offline ordering dropped every item into the course-bar selection.
        default_course: i.default_course,
        // SEPOS-STATION-003 — per-dish station override; included from day
        // one so it can never hit the dropped-projection bug class above.
        printer_id: i.printer_id,
      }))
    );

    // printer_id opted into null-sync so removing a category→printer route in
    // the till actually clears on desktop (SEPOS-PRINT-002 flexible routing).
    const nCat   = await upsertRows('categories', 'id', flatCategories, ['printer_id']);
    const nSub   = await upsertRows('subcategories', 'id', flatSubcategories);
    // menu_items.printer_id (SEPOS-STATION-003 per-dish override) also
    // null-syncs, so switching a dish back to "Inherit" clears on desktop.
    const nItems = await upsertRows('menu_items', 'id', flatItems, ['printer_id']);

    // SEPOS-046p — propagate cloud-side deletions. Pull was upsert-only
    // before, so deleting an item / subcategory / category on the web
    // admin left orphan rows in local SQLite forever. Now: anything
    // present locally but missing from the cloud snapshot is removed.
    // Safe because we only reach this branch after a successful cloud
    // fetch with a non-empty top-level array — no risk of wiping
    // local data due to a transient network blip.
    const nItemsDel = await deleteOrphans('menu_items',   flatItems.map(i => i.id));
    const nSubDel   = await deleteOrphans('subcategories', flatSubcategories.map(s => s.id));
    const nCatDel   = await deleteOrphans('categories',    flatCategories.map(c => c.id));
    console.log(`[sync] pull menu tree: ${nCat}/${nSub}/${nItems} upserts (cats/subs/items), ${nCatDel}/${nSubDel}/${nItemsDel} deletes`);

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
      // REG-1 (Nook) — send the install's SYNC_SECRET on every pull: the
      // voucher endpoints are now auth-gated on the cloud (they were leaking
      // codes/balances publicly), and the header is harmless on open ones.
      const r = await fetch(CLOUD_API_URL + ep.path, {
        headers: process.env.SYNC_SECRET ? { 'x-sync-secret': process.env.SYNC_SECRET } : {},
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!r.ok) {
        console.warn(`[sync] pull ${ep.path} ${r.status}`);
        continue;
      }
      const rows = await r.json();
      // SEPOS-060 fix — GET /api/settings returns an OBJECT {key:value}, not an
      // array, so the old `Array.isArray ? rows : rows?.data || []` discarded it
      // every tick and settings (printer IP, Thai codepage, service charge…)
      // never reached a freshly-provisioned till. Map the object to rows.
      let list = Array.isArray(rows) ? rows
        : ep.table === 'settings' ? Object.entries(rows || {})
            .filter(([key]) => !isDeviceOwnedSettingKey(key))
            .map(([key, value]) => ({ key, value }))
        : (rows?.data || []);
      // SEPOS-AUDIT-001 — till_sessions guard. (a) While a session open/close
      // replay is still queued, the cloud's view is stale — skip the pull
      // entirely this tick (mirrors ordersWithPendingPush). (b) Never let a
      // cloud row flip a locally-CLOSED session back to 'open': cloud and
      // local session ids are independent sequences, so after an offline
      // close the cloud's still-open row (same numeric id) used to reopen
      // yesterday's shift on the till.
      if (ep.table === 'till_sessions') {
        const pendingSessions = await hasPendingQueueAction(
          ['session_open', 'session_close'], () => true);
        if (pendingSessions) continue;
        const filtered = [];
        for (const row of list) {
          if (row && row.id != null && row.status === 'open') {
            const loc = await pool.query(
              `SELECT status FROM till_sessions WHERE id = $1`, [row.id]);
            if (loc.rows[0]?.status === 'closed') continue;   // local close wins
          }
          filtered.push(row);
        }
        list = filtered;
      }
      const n = await upsertRows(ep.table, ep.pk, list);
      if (n > 0) console.log(`[sync] pull ${ep.table}: ${n} rows`);
      // SEPOS-059 fix — cloud-wins DELETE for flagged flat tables (the modifier
      // library). The pull was upsert-only, so a group/option/link deleted or
      // detached on cloud lingered on the till forever. Gated on r.ok (checked
      // above) so a transient failure never wipes local; an empty 200 list
      // legitimately means "cloud has none" → remove all local.
      if (ep.orphan && ep.pk === 'id') {
        const removed = await deleteOrphans(ep.table, list.map((row) => row.id));
        if (removed > 0) console.log(`[sync] orphan-delete ${ep.table}: ${removed} rows`);
      }
    } catch (err) {
      console.warn(`[sync] pull ${ep.path} failed:`, err.message);
    }
  }

  // SEPOS-047k — staff via the gated feed (needs pins; see pullStaff).
  await pullStaff();

  // Nested menu tree (categories + items). Modifiers + the shared library
  // (groups, options, dish↔group join) now sync as flat cloud-wins tables in
  // PULL_TABLES (SEPOS-059), so there's no per-item modifier pull here.
  await pullMenuTree();

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

  // Snapshot which local rows have Mac-side pending mutations — those
  // are skipped below to avoid the "tap → appears → snaps back → reappears"
  // rollback effect.
  const pendingOrderIds = await ordersWithPendingPush();
  const pendingItemIds  = await itemsWithPendingPush();
  // Cloud ids the Mac is currently deleting (their local rows are already
  // gone — pull must NOT re-INSERT them while the push is in flight).
  const pendingDeleteCloudIds = await cloudIdsWithPendingDelete();

  // SEPOS-AUDIT-001 (verify pass) — the deletion reconciliation MUST run even
  // when the snapshot is EMPTY: deleting the ONLY open order on the cloud (the
  // most common ops-support delete, typically end of night) produces exactly
  // that empty snapshot, and the old placement (after the early return below)
  // made the probe dead code for it — the ghost stayed on the floor.
  await reconcileCloudDeletions(orders, pendingOrderIds, pendingDeleteCloudIds);

  if (orders.length === 0) return;

  let inserted = 0, updated = 0, skippedPending = 0, skippedDelete = 0;

  // ─── Orders ───────────────────────────────────────────────────────
  // For each cloud order, either UPDATE the local row that already has
  // this cloud_id, or INSERT a new local row carrying the cloud_id.
  const orderColsRow = await pool.query('PRAGMA table_info(orders)');
  const orderCols = orderColsRow.rows.map(r => r.name);
  for (const cloudOrder of orders) {
    const cloudId = cloudOrder.id;
    if (!cloudId) continue;
    // Mac just deleted this order and the cloud push hasn't gone out yet.
    // Skipping prevents the rollback flash where the deleted order
    // reappears for ~5s until the push completes.
    if (pendingDeleteCloudIds.has(Number(cloudId))) { skippedDelete++; continue; }
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
      // If Mac has pending mutations for this order, the cloud's view is
      // stale relative to ours. Skip the UPDATE — the next sync push will
      // bring cloud level with us, and a subsequent pull then has the
      // freshest data on both sides.
      if (pendingOrderIds.has(localId)) {
        skippedPending++;
      } else {
        // SEPOS-AUDIT-001 — CRITICAL: never downgrade a locally CLOSED /
        // CANCELLED bill back to 'open'. If the pay/cancel push hasn't
        // landed yet (e.g. cloud was 502ing and the entry is retrying, or
        // it was quarantined), the cloud copy still says 'open' — cloud-wins
        // here used to flip the till's PAID bill back onto the floor,
        // inviting a second payment. The till is authoritative for a close
        // it performed; skip until the push closes the cloud copy too.
        const st = await pool.query('SELECT status FROM orders WHERE id = $1', [localId]);
        const localStatus = st.rows[0]?.status;
        if ((localStatus === 'closed' || localStatus === 'cancelled') && fields.status === 'open') {
          skippedPending++;
        } else {
          const setCols = Object.keys(fields).filter(k => k !== 'cloud_id');
          if (setCols.length > 0) {
            const sets = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
            await pool.query(
              `UPDATE orders SET ${sets} WHERE id = $${setCols.length + 1}`,
              [...setCols.map(c => fields[c]), localId]
            );
            updated++;
          }
        }
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
      if (pendingItemIds.has(localItemId)) {
        // Mac has a pending void / status / add for this item.
        // Skip — push will resolve, next pull will reconcile.
      } else {
        const setCols = Object.keys(fields).filter(k => k !== 'cloud_id');
        if (setCols.length > 0) {
          const sets = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
          await pool.query(
            `UPDATE order_items SET ${sets} WHERE id = $${setCols.length + 1}`,
            [...setCols.map(c => fields[c]), localItemId]
          );
          itemsUpdated++;
        }
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

  if (inserted || updated || itemsInserted || itemsUpdated || skippedPending || skippedDelete) {
    console.log(`[sync] active-orders: ${inserted}+${updated} orders, ${itemsInserted}+${itemsUpdated} items${itemsSkipped ? ` (${itemsSkipped} item-skips, parent not yet pulled)` : ''}${skippedPending ? ` (${skippedPending} skipped — local pending)` : ''}${skippedDelete ? ` (${skippedDelete} skipped — pending delete push)` : ''}`);
  }

}

// ─── SEPOS-AUDIT-001: reconcile cloud-side deletions ────────────────
// pullActiveOrders only inserts/updates and the closed-orders feed only
// covers status='closed', so an order hard-DELETEd on the cloud (ops
// support, or a browser terminal's DELETE /api/orders/:id) used to leave a
// permanent ghost open order on the till — it has real items, so the
// 0-item display filter never hides it, and the table shows occupied
// forever. Any local OPEN order that (a) is bound to a cloud_id, (b) is
// absent from this active snapshot, and (c) has no pending local push is
// probed individually: cloud 404 → it was deleted → cancel it locally and
// free the table. A 200 means it merely closed (the closed-orders pull
// will reconcile) — leave it alone. Capped per tick to bound work.
// (Verify pass: extracted to run BEFORE the empty-snapshot early return.)
async function reconcileCloudDeletions(orders, pendingOrderIds, pendingDeleteCloudIds) {
  try {
    const snapshotIds = new Set(orders.map(o => Number(o.id)));
    const localOpen = await pool.query(
      `SELECT id, cloud_id, table_id FROM orders WHERE status = 'open' AND cloud_id IS NOT NULL`
    );
    let probed = 0, ghostsCancelled = 0;
    for (const row of localOpen.rows) {
      if (probed >= 5) break;                                   // bound per tick
      const cid = Number(row.cloud_id);
      if (snapshotIds.has(cid)) continue;                       // still active on cloud
      if (pendingOrderIds.has(Number(row.id))) continue;        // our push in flight
      if (pendingDeleteCloudIds.has(cid)) continue;             // our delete in flight
      probed++;
      try {
        const pr = await fetch(`${CLOUD_API_URL}/api/orders/${cid}`, {
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        if (pr.status === 404) {
          await pool.query(
            `UPDATE orders SET status = 'cancelled', closed_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'open'`,
            [row.id]
          );
          if (row.table_id) {
            await pool.query(`UPDATE tables SET status = 'available' WHERE id = $1`, [row.table_id]);
          }
          ghostsCancelled++;
          console.log(`[sync] local order ${row.id} (cloud ${cid}) was deleted on the cloud — cancelled locally`);
        }
      } catch { /* offline blip — retry next tick */ }
    }
    if (ghostsCancelled) console.log(`[sync] reconciled ${ghostsCancelled} cloud-deleted order(s)`);
  } catch (err) {
    console.warn('[sync] deletion reconciliation skipped:', err.message);
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

// SEPOS — mirror a batch of closed orders into local SQLite, keyed by
// cloud_id (consistent with pullActiveOrders). For each closed cloud
// order: UPDATE the local row already bound to that cloud_id, or INSERT
// a fresh local row carrying the cloud_id. Children (items + payments)
// are delete-and-replaced — a closed order is terminal so there are no
// local edits to preserve, and a clean replace is naturally idempotent
// (re-pulling the same closed order can't accumulate duplicate items).
async function upsertClosedOrders(orders, order_items, payments) {
  const orderCols = (await pool.query('PRAGMA table_info(orders)')).rows.map(r => r.name);
  const itemCols  = (await pool.query('PRAGMA table_info(order_items)')).rows.map(r => r.name);
  const payCols   = (await pool.query('PRAGMA table_info(payments)')).rows.map(r => r.name);

  // Group children by their cloud order_id.
  const itemsByCloudOrder = {};
  for (const it of order_items) (itemsByCloudOrder[it.order_id] ||= []).push(it);
  const paysByCloudOrder = {};
  for (const p of payments) (paysByCloudOrder[p.order_id] ||= []).push(p);

  // Build an INSERT/UPDATE-safe field map: known columns only, drop the
  // cloud `id` and `order_id` (we map those ourselves), drop nulls so a
  // cloud null can't clobber a local default.
  const pickFields = (row, cols, extra) => {
    const f = { ...extra };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id' || k === 'order_id') continue;
      if (!cols.includes(k)) continue;
      if (v === null || v === undefined) continue;
      f[k] = v;
    }
    return f;
  };

  let skipped = 0, closedApplied = 0;
  // SEPOS-047f — local orders with a pending push are authoritative; never
  // clobber them with the cloud echo.
  const pendingOrderIds = await ordersWithPendingPush();
  for (const cloudOrder of orders) {
    const cloudId = cloudOrder.id;
    if (!cloudId) continue;

    let localId = await findLocalOrderByCloudId(cloudId);
    const fields = pickFields(cloudOrder, orderCols, { cloud_id: cloudId });

    if (localId) {
      // SEPOS-LOCAL-001 Phase 2 — Mac is the source of truth for orders it
      // owns. BUT: an order created on a CLOUD terminal is pulled here while
      // still open (SEPOS-PRO-002 bidirectional flow); when it's later
      // closed/paid on the cloud it vanishes from the active-orders feed,
      // and this function used to skip it because the cloud_id was already
      // bound — so it stayed status='open' on the till FOREVER, with its
      // payments never landing locally (missing from Z-report + bill
      // history). SEPOS-047f: if the local row is still 'open' and the till
      // has no pending push for it, apply the close (UPDATE + children
      // replace) below. Only skip when local is already closed or we own a
      // pending mutation for it.
      const stRes = await pool.query('SELECT status FROM orders WHERE id = $1', [localId]);
      const localStatus = stRes.rows[0]?.status;
      if (localStatus === 'open' && !pendingOrderIds.has(Number(localId))) {
        const setCols = Object.keys(fields).filter(k => k !== 'cloud_id');
        if (setCols.length > 0) {
          const sets = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
          await pool.query(
            `UPDATE orders SET ${sets} WHERE id = $${setCols.length + 1}`,
            [...setCols.map(c => fields[c]), localId]
          );
        }
        closedApplied++;
        // fall through to the children replace below
      } else {
        skipped++;
        continue;
      }
    } else {
      const cols = Object.keys(fields);
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      const ins = await pool.query(
        `INSERT INTO orders (${cols.join(',')}) VALUES (${ph}) RETURNING id`,
        cols.map(c => fields[c])
      );
      localId = ins.rows[0]?.id;
    }
    if (!localId) continue;

    // Children — clean replace under the resolved local id.
    await pool.query('DELETE FROM order_items WHERE order_id = $1', [localId]);
    for (const it of (itemsByCloudOrder[cloudId] || [])) {
      const f = pickFields(it, itemCols, { order_id: localId });
      if (itemCols.includes('cloud_id') && it.id) f.cloud_id = it.id;
      const cols = Object.keys(f);
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      try {
        await pool.query(`INSERT INTO order_items (${cols.join(',')}) VALUES (${ph})`, cols.map(c => f[c]));
      } catch (err) { console.warn('[sync] closed-order item insert failed:', err.message); }
    }

    await pool.query('DELETE FROM payments WHERE order_id = $1', [localId]);
    for (const p of (paysByCloudOrder[cloudId] || [])) {
      const f = pickFields(p, payCols, { order_id: localId });
      const cols = Object.keys(f);
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      try {
        await pool.query(`INSERT INTO payments (${cols.join(',')}) VALUES (${ph})`, cols.map(c => f[c]));
      } catch (err) { console.warn('[sync] closed-order payment insert failed:', err.message); }
    }
  }
  if (skipped > 0 || closedApplied > 0) console.log(`[sync] closed-orders: ${closedApplied} applied (cloud-closed), ${skipped} skipped (already local — Phase 2)`);
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

    // SEPOS — match closed orders by cloud_id, NOT by primary-key id.
    // The old `upsertRows('orders','id',…)` treated the cloud's id as
    // the local id, but pullActiveOrders keys orders by cloud_id with a
    // separate local id. An order pulled while open (by cloud_id) and
    // then again once closed (by id) produced TWO local rows — the
    // duplicate-bill bug. upsertClosedOrders uses cloud_id throughout.
    await upsertClosedOrders(orders, order_items, payments);
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

let _lastWarnedSecret = 0;

// Max pushes for an item that keeps hitting server errors (5xx) before we
// give up and quarantine it, so a server-side bug on one action can't retry
// forever. Pure network/timeout failures (an outage) do NOT count toward this
// — we keep retrying those until connectivity returns.
const MAX_SYNC_ATTEMPTS = 6;

// Pull the HTTP status out of an applyToCloud error ("pay_order 409" → 409).
// Null = no server response (network / timeout / DNS) = a transient outage.
function errHttpStatus(err) {
  const m = /\b([1-5]\d{2})\b/.exec(String(err && err.message || ''));
  return m ? Number(m[1]) : null;
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
      const httpStatus = errHttpStatus(err);
      // SEPOS-AUDIT-001 — an action that flagged itself permanent must
      // quarantine even when its status is 401/403 (e.g. amend_method's PIN
      // rejected by the CLOUD staff table): treating it as a global auth
      // failure below would halt the whole queue forever on one bad entry.
      if (err.permanent === true) {
        console.error(`[sync] ${entry.action_type}#${entry.id} quarantined (permanent): ${err.message}`);
        await offlineQueue.markFailed(entry.id, err.message);
        continue;
      }
      // Auth failure (bad/missing SYNC_SECRET) affects EVERY gated push — not
      // this one item. Stop and surface it; don't quarantine (it's a config
      // fix, and the actions are still valid once the secret is right).
      if (httpStatus === 401 || httpStatus === 403) {
        console.error(`[sync] ${entry.action_type}#${entry.id} auth failed (${httpStatus}) — check SYNC_SECRET`);
        setStatus('auth_error');
        // SEPOS-AUDIT-001 (verify pass) — return the state as a hint so tick()
        // doesn't immediately overwrite it with a healthy-looking 'syncing'.
        return 'auth_error';
      }
      // Permanent data error (4xx: order already closed / not found / conflict /
      // unprocessable), or an action that flagged itself permanent (e.g. a
      // mutation whose parent create_order failed, so its cloud_id can never
      // bind — SEPOS-AUDIT-001). It will NEVER succeed — quarantine it and
      // KEEP DRAINING so it can't head-of-line-block the live orders behind it.
      const permanent = err.permanent === true
        || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500);
      const attempts = (entry.attempts || 0) + 1;
      // SEPOS-AUDIT-001 — CRITICAL: state-mutating actions must NEVER be
      // quarantined on 5xx. A routine Railway redeploy answers 502 for a
      // couple of minutes; at one attempt per 5s tick the old rule
      // (attempts >= 6) quarantined a pay_order in ~30s — the cloud copy then
      // stayed open forever and the pull flipped the till's PAID bill back to
      // 'open', inviting a second charge. The verify pass extended this to
      // EVERY order/money-state replay (merge, close, cancel, collected,
      // discounts, amendments, sessions…) — the same redeploy would have
      // quarantined those, leaving the un-pushed change to be reverted by the
      // pull. Only pure-settings pushes may exhaust: their replay is
      // idempotent and losing one is recoverable from the admin screen.
      const EXHAUSTIBLE_ACTIONS = new Set(['update_kv_settings', 'update_restaurant_settings']);
      const exhausted = httpStatus !== null && attempts >= MAX_SYNC_ATTEMPTS
        && EXHAUSTIBLE_ACTIONS.has(entry.action_type);
      if (permanent || exhausted) {
        console.error(`[sync] ${entry.action_type}#${entry.id} quarantined after ${attempts} attempt(s): ${err.message}`);
        await offlineQueue.markFailed(entry.id, err.message);
        continue; // ← the fix: move on instead of freezing the whole queue
      }
      // Transient: a 5xx (server restarting) or a network/timeout (outage).
      // Bump the counter only when the server actually answered (5xx) so an
      // outage doesn't burn the attempt budget; then stop this tick and retry
      // the whole queue next tick once things recover.
      if (httpStatus !== null) {
        await offlineQueue.bumpAttempt(entry.id, err.message);
        if (attempts >= MAX_SYNC_ATTEMPTS) {
          // SEPOS-AUDIT-001 (verify pass) — a deterministic 5xx on a retained
          // action now head-of-line-blocks the queue by design (better than
          // wrong money), but it must be VISIBLE: surface 'stuck' so the pill
          // stops showing a healthy-looking eternal 'syncing'.
          console.error(`[sync] ${entry.action_type}#${entry.id} still failing after ${attempts} attempts (${err.message}) — retrying until the cloud recovers; queue is blocked behind it`);
          return 'stuck';
        }
      } else {
        console.warn(`[sync] ${entry.action_type}#${entry.id} deferred (no response — offline?): ${err.message}`);
      }
      return;
    }
  }
  // SEPOS-047f — the in-memory orderIdMap was removed in SEPOS-PRO-002
  // (replaced by orders.cloud_id columns). The leftover orderIdMap.clear()
  // threw a ReferenceError after every fully-drained queue, which
  // propagated into tick() and SKIPPED that tick's pullFromCloud — so the
  // pull a busy till most needs (right after pushing) was always lost, and
  // the log filled with "tick failed: orderIdMap is not defined" every 5s.
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

    // SEPOS-AUDIT-001 (verify pass) — honour syncOnce's status hint
    // ('auth_error' / 'stuck'): the unconditional healthy setStatus below used
    // to overwrite those within the same tick, so a wrong SYNC_SECRET or a
    // head-of-line-blocked queue showed as an eternal healthy 'syncing'.
    const hint = await syncOnce();
    await pullFromCloud();
    const remaining = await offlineQueue.pendingCount();
    setStatus(hint || (remaining > 0 ? 'syncing' : 'cloud'));
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

// SEPOS-046ad — targeted menu refresh, awaited by server.js right after a
// forwarded menu admin write succeeds on the cloud. Pulls ONLY the menu
// tree (one /api/menu/all request) so the Order screen and Menu Manager
// see the change immediately instead of on the next 5s tick. Deliberately
// skips pullModifiersForMenuItems (one request per item — too slow to sit
// inside a write's response); the regular tick still covers modifiers.
async function pullMenuSnapshot() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;
  await pullMenuTree();
}

// SEPOS-027 — pull the floor plan (tables + linked groups) back immediately
// after a till edit forwards to cloud, so the cloud (which online booking uses
// for table-aware availability) and the till stay in lock-step.
async function pullTablesSnapshot() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;
  const feeds = [
    { path: '/api/tables', table: 'tables' },
    { path: '/api/table-combinations', table: 'table_combinations' },
  ];
  for (const f of feeds) {
    try {
      const r = await fetch(CLOUD_API_URL + f.path, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      if (!r.ok) continue;
      const rows = await r.json();
      const list = Array.isArray(rows) ? rows : (rows?.data || []);
      await upsertRows(f.table, 'id', list);
      await deleteOrphans(f.table, list.map((row) => row.id));
    } catch (err) {
      console.warn(`[sync] pullTablesSnapshot ${f.path} failed:`, err.message);
    }
  }
}

// SEPOS-059 — pull the flat modifier-library tables back immediately after a
// modifier write forwards to cloud. Without this the till's admin refetch read
// stale local data (the new option/group only landed on the next 5s tick, so it
// "didn't show until you closed and reopened"). pullMenuSnapshot only pulls the
// menu TREE — not these flat tables, which is what GET .../modifiers reads.
// Same feeds + orphan-delete as the main pull loop; gated on r.ok.
async function pullModifiersSnapshot() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;
  const feeds = [
    { path: '/api/modifier-groups-all', table: 'modifier_groups' },
    { path: '/api/modifiers-all', table: 'modifiers' },
    { path: '/api/menu-item-modifier-groups', table: 'menu_item_modifier_groups' },
  ];
  for (const f of feeds) {
    try {
      const r = await fetch(CLOUD_API_URL + f.path, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      if (!r.ok) continue;
      const rows = await r.json();
      const list = Array.isArray(rows) ? rows : (rows?.data || []);
      await upsertRows(f.table, 'id', list);
      await deleteOrphans(f.table, list.map((row) => row.id));
    } catch (err) {
      console.warn(`[sync] pullModifiersSnapshot ${f.path} failed:`, err.message);
    }
  }
}

// SEPOS-053 — targeted till_sessions refresh, awaited by server.js right after
// a forwarded session open/close succeeds on the cloud, so the till's shift
// banner reflects it immediately instead of on the next 5s tick.
async function pullSessionsSnapshot() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;
  try {
    const r = await fetch(CLOUD_API_URL + '/api/till-sessions', {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!r.ok) return;
    const rows = await r.json();
    const list = Array.isArray(rows) ? rows : (rows?.data || []);
    await upsertRows('till_sessions', 'id', list);
  } catch (err) {
    console.warn('[sync] pullSessionsSnapshot failed:', err.message);
  }
}

// SEPOS-047g — targeted staff refresh, awaited by server.js right after a
// forwarded staff write (add/edit/delete a PIN) succeeds on the cloud, so
// the till's Staff list and the login PINs reflect it immediately. Unlike
// the regular PULL_TABLES staff pull (upsert-only), this also orphan-deletes
// local staff missing from the cloud snapshot, so a desktop-initiated DELETE
// actually removes the row locally (guarded to a non-empty cloud list so a
// transient blank response can't wipe the staff table).
// SEPOS-047k — pull staff via the SYNC_SECRET-gated /api/sync/staff feed,
// which (unlike public /api/staff) includes pin. The local staff.pin is
// NOT NULL, so a pin-less pull hit the constraint and skipped every row —
// cloud staff never reached the till. Orphan-deletes so cloud-side staff
// deletions propagate (guarded to a non-empty list). Silently no-ops
// without SYNC_SECRET (the feed 401s), same as the other gated pulls.
async function pullStaff() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL || !process.env.SYNC_SECRET) return;
  try {
    const r = await fetch(CLOUD_API_URL + '/api/sync/staff', {
      headers: { 'x-sync-secret': process.env.SYNC_SECRET },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!r.ok) { console.warn(`[sync] pullStaff ${r.status}`); return; }
    const rows = await r.json();
    const list = Array.isArray(rows) ? rows : (rows?.data || []);
    if (!Array.isArray(list) || list.length === 0) return;
    const n = await upsertRows('staff', 'id', list);
    await deleteOrphans('staff', list.map(s => s.id));
    if (n > 0) console.log(`[sync] pull staff: ${n} rows`);
  } catch (err) {
    console.warn('[sync] pullStaff failed:', err.message);
  }
}

// Instant staff refresh after a forwarded staff write (add/edit/delete a
// PIN) succeeds on the cloud — same gated feed as the tick.
async function pullStaffSnapshot() {
  await pullStaff();
}

module.exports = { start, stop, getStatus, onStatusChange, syncOnce, pullFromCloud, pullClosedOrders, pullActiveOrders, pullMenuSnapshot, pullModifiersSnapshot, pullTablesSnapshot, pullStaffSnapshot, pullSessionsSnapshot, tick };
