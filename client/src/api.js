import { cachePut, cacheGet, cacheLogin, lookupLogin, localOrderCreate, localOrderGet, localOrderUpdate, localOrderListOpen, localItemPatch, localOrderListUnsynced, localOrderMarkSynced } from './native/localdb';
import { nativeRequest } from './native/http';

// SEPOS-ANDROID — old Sunmi WebViews choke on `fetch` against some tenant
// backends; route every request through the native Android HTTP stack
// (CapacitorHttp) on-device. Web POS / Electron desktop keep `fetch` untouched.
const useNativeHttp = () => {
  try {
    return !!(typeof window !== 'undefined' && window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  } catch { return false; }
};

// SEPOS-ANDROID-002 — offline orders carry a temp string id like "L1719…".
const isLocalId = (id) => typeof id === 'string' && String(id).startsWith('L');
// Local order-item ids look like 'LI<ts>_<i>' (note: also pass isLocalId since
// they start with 'L', so always test isLocalItemId FIRST where it matters).
const isLocalItemId = (id) => typeof id === 'string' && String(id).startsWith('LI');

// The shared MAIN SiamEPOS cloud, and the ONLY public host allowed to use it
// without an explicit VITE_API_URL. Every other public host MUST declare its
// restaurant's backend via the VITE_API_URL build env var — otherwise it is a
// misconfigured per-tenant deploy and we refuse to silently serve the main
// cloud's data (the tenant-leak that made siamepos-thannthai show app.siamepos
// data — SEPOS-TENANT-GUARD-001).
const MAIN_CLOUD = 'https://restaurant-epos-production.up.railway.app';
const MAIN_HOSTS = ['app.siamepos.co.uk'];
// Set true by getServerURL() when a per-tenant site is missing its VITE_API_URL.
// Snapshotted into the exported TENANT_MISCONFIGURED const below (after
// getServerURL runs at module init) and read by App.jsx to block with a loud
// setup-error screen instead of loading another restaurant's data.
let tenantMisconfigured = false;

const getServerURL = () => {
  // Electron desktop: the bundled local server lives on :3001 regardless of
  // how the renderer was loaded (file:// in prod, http://localhost:5173 in dev).
  // window.siamepos is injected by electron/preload.js.
  if (typeof window !== 'undefined' && window.siamepos && window.siamepos.isElectron) {
    return 'http://localhost:3001';
  }

  // SEPOS-ANDROID-001 — Capacitor native app (Android). The bundle is served
  // from https://localhost, so without this it would wrongly hit :3001. Use the
  // per-device tenant URL chosen on first launch (empty → SetupScreen gates the app).
  if (typeof window !== 'undefined' && window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
    try { return (localStorage.getItem('siamepos_tenant_url') || '').replace(/\/+$/, ''); } catch { return ''; }
  }

  const host = window.location.hostname;
  // If running on localhost or local IP (192.168.x.x or 10.x.x.x)
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    host.startsWith('172.')
  ) {
    return `http://${host}:3001`;
  }
  // Per-client Netlify deploy: the site declares its restaurant's backend via
  // the VITE_API_URL build env var.
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  // No VITE_API_URL on a public host. Only the shared MAIN site may use the main
  // cloud without one; ANY other public host here is a per-tenant site built
  // without its VITE_API_URL. Do NOT silently serve the main cloud — flag it so
  // App.jsx blocks with a setup error instead of showing the wrong restaurant.
  if (!MAIN_HOSTS.includes(host)) {
    tenantMisconfigured = true;
    try { console.error(`[SiamEPOS] Misconfigured deploy: ${host} has no VITE_API_URL. Refusing to fall back to the main cloud.`); } catch {}
  }
  return MAIN_CLOUD;
};

export const SERVER_URL = getServerURL();
// Snapshot AFTER getServerURL() has run (it sets the flag as a side effect).
export const TENANT_MISCONFIGURED = tenantMisconfigured;

// SEPOS-047a — both login paths store a Bearer token; attach it to every
// request so staff-gated endpoints (customers, campaigns, AI scan) work.
// PIN sessions live under 'siamepos_token' (NOT 'siamepos_auth', which
// App.jsx auto-restores on load — PIN users must still log in per shift).
export const authHeaders = () => {
  try {
    const raw = localStorage.getItem('siamepos_token') || localStorage.getItem('siamepos_auth');
    if (!raw) return {};
    const a = JSON.parse(raw);
    if (a?.token && (!a.expires_at || a.expires_at > Date.now())) {
      return { Authorization: `Bearer ${a.token}` };
    }
  } catch {}
  return {};
};
export const storePinSession = (r) => {
  try {
    if (r?.token) localStorage.setItem('siamepos_token', JSON.stringify({ token: r.token, expires_at: r.expires_at }));
  } catch {}
};

// SEPOS-ANDROID-002 — offline read cache (native only, additive). Try cloud
// first; cache good responses; on a network failure serve the last cached copy
// so the till keeps working with no internet. On web/desktop cachePut/cacheGet
// no-op, so behaviour is unchanged.
const get = async (url) => {
  try {
    const json = useNativeHttp()
      ? await nativeRequest('GET', SERVER_URL + url, { headers: authHeaders() })
      : await (await fetch(SERVER_URL + url, { headers: authHeaders() })).json();
    if (json && !json.error) cachePut(url, json);   // fire-and-forget
    return json;
  } catch (e) {
    const cached = await cacheGet(url);
    if (cached !== undefined) return cached;
    throw e;
  }
};
const post = (url, data) => useNativeHttp()
  ? nativeRequest('POST', SERVER_URL + url, { headers: { 'Content-Type': 'application/json', ...authHeaders() }, data })
  : fetch(SERVER_URL + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data)
    }).then(r => r.json());
const put = (url, data) => useNativeHttp()
  ? nativeRequest('PUT', SERVER_URL + url, { headers: { 'Content-Type': 'application/json', ...authHeaders() }, data })
  : fetch(SERVER_URL + url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data)
    }).then(r => r.json());
const del = (url) => useNativeHttp()
  ? nativeRequest('DELETE', SERVER_URL + url, { headers: authHeaders() })
  : fetch(SERVER_URL + url, { method: 'DELETE', headers: authHeaders() }).then(r => r.json());

// SEPOS-046y — the helpers above resolve (not reject) on HTTP 4xx/5xx, so a
// try/catch around them only sees network failures. Optimistic-UI handlers
// must run their response through assertOk so a server-side {error} also
// lands in the catch block and triggers the rollback + operator alert.
export const assertOk = (res) => {
  if (res && res.error) throw new Error(res.error);
  return res;
};

export const getTables = () => get('/api/tables');
export const updateTableStatus = (id, status) => put(`/api/tables/${id}`, { status });
// SEPOS-ANDROID-002 — when online, warm EVERY item's modifiers into the cache
// (once) so offline taps still show modifier choices. Background, best-effort.
const isNative = () => {
  try { return !!(typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  catch { return false; }
};
let _modWarmed = false;
async function warmModifiers(menu) {
  if (_modWarmed || !Array.isArray(menu)) return;
  if (!isNative()) return;   // only the on-device till caches modifiers; web/desktop skip
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  _modWarmed = true;
  try {
    const ids = [];
    for (const cat of menu) for (const it of (cat.items || [])) if (it?.id != null) ids.push(it.id);
    for (const id of ids) { try { await get(`/api/menu/items/${id}/modifiers`); } catch {} }
  } catch {}
}
export const getMenu = async () => {
  const menu = await get('/api/menu');
  if (Array.isArray(menu)) warmModifiers(menu);
  return menu;
};
export const getAllMenu = () => get('/api/menu/all');
export const addMenuItem = (item) => post('/api/menu/items', item);
export const updateMenuItem = (id, item) => put(`/api/menu/items/${id}`, item);
// SEPOS-ANDROID-002 — "promote" a cloud order into the local store so a table
// opened BEFORE the outage can still be edited offline. Keyed by its own
// (stringified) cloud id and carries cloud_id, so the sync engine later pushes
// the offline edits back as a DELTA to the existing cloud order rather than
// creating a duplicate. Native-only; returns null (no-op) on web/desktop.
async function promoteOrder(cloudId) {
  if (!isNative()) return null;
  try {
    const existing = await localOrderGet(String(cloudId));
    if (existing) return String(cloudId);          // already promoted
    let snap = await cacheGet(`/api/orders/${cloudId}`);
    if (!snap || snap.id == null) {
      const list = await cacheGet('/api/orders');
      snap = (list || []).find(o => o.id === cloudId);
    }
    if (!snap) return null;                          // never cached → can't promote
    const doc = {
      ...snap, id: String(cloudId), cloud_id: cloudId, promoted: true, offline: true, synced: 0,
      status: snap.status || 'open',
      items: Array.isArray(snap.items) ? snap.items.map(it => ({ ...it })) : [],
    };
    await localOrderCreate(doc);
    return String(cloudId);
  } catch { return null; }
}
// Resolve which local doc-key an order id maps to, or null to use the cloud.
// 'L…' = born offline; a promoted cloud order is stored under its numeric id.
async function localTarget(orderId) {
  if (isLocalId(orderId)) return orderId;
  if (!isNative()) return null;
  try { const p = await localOrderGet(String(orderId)); if (p && p.synced === 0) return String(orderId); } catch {}
  return null;
}
// Append cart items to a local order doc (shared by 'L…' and promoted orders).
async function localAppendItems(lid, items) {
  const doc = await localOrderGet(lid);
  if (!doc) return { error: 'Order not found' };
  if (!Array.isArray(doc.items)) doc.items = [];
  (items || []).forEach((it, i) => {
    doc.items.push({
      id: 'LI' + Date.now() + '_' + i,
      order_id: lid,
      menu_item_id: it.menu_item_id ?? null,
      item_name: it.name, name: it.name, name_alt: it.name_alt || '',
      quantity: it.quantity || 1,
      unit_price: it.unit_price ?? it.server_price ?? it.price ?? 0,
      notes: it.notes || '', item_note: it.item_note || '',
      course: it.course || 1,
      is_bar: it.is_bar ? 1 : 0,
      category_id: it.category_id ?? null,   // SEPOS-MISC-001 — drives kitchen/bar + printer routing for custom (menu_item_id=null) lines
      status: it.is_bar ? 'cooking' : 'pending',
      is_fired: it.is_bar ? 1 : 0,
      voided: 0,
      modifiers: it.modifiers || [],   // kept so the cloud re-prices add-ons on sync
    });
  });
  doc.total = doc.items.filter(x => !x.voided)
    .reduce((s, x) => s + (Number(x.unit_price) || 0) * (Number(x.quantity) || 1), 0);
  await localOrderUpdate(lid, doc);
  return { success: true };
}

// Open orders = cloud (or cache) PLUS any orders created/promoted offline. Drop
// the cached cloud copy of anything we've promoted locally to avoid duplicates.
export const getOrders = async () => {
  const base = await get('/api/orders');
  let locals = [];
  try { locals = await localOrderListOpen(); } catch {}
  const arr = Array.isArray(base) ? base : [];
  if (!locals.length) return arr;
  const promoted = new Set(locals.filter(o => o.cloud_id != null).map(o => o.cloud_id));
  const deduped = promoted.size ? arr.filter(o => !promoted.has(o.id)) : arr;
  return [...deduped, ...locals];
};
export const getOrder = async (id) => {
  if (isLocalId(id)) { const d = await localOrderGet(id); return d || { error: 'Order not found' }; }
  // Already promoted (has unsynced offline edits)? Show the local copy.
  if (isNative()) {
    try { const p = await localOrderGet(String(id)); if (p && p.synced === 0) return p; } catch {}
  }
  try {
    const json = useNativeHttp()
      ? await nativeRequest('GET', SERVER_URL + `/api/orders/${id}`, { headers: authHeaders() })
      : await (await fetch(SERVER_URL + `/api/orders/${id}`, { headers: authHeaders() })).json();
    if (json && !json.error) cachePut(`/api/orders/${id}`, json);
    return json;
  } catch (e) {
    if (!isNative()) throw e;
    const pid = await promoteOrder(id);            // offline: make this table editable now
    if (pid) { const p = await localOrderGet(pid); if (p) return p; }
    const cached = await cacheGet(`/api/orders/${id}`);
    return cached !== undefined ? cached : { error: 'Order not found' };
  }
};
// Online → cloud. Offline (network fail) → create the order locally with a temp
// id so the floor + order screen work; it syncs to the cloud later.
// SEPOS-TAKEAWAY-TABLE — order_type defaults to dine_in; a takeaway-flagged
// table passes 'takeaway' so the order skips service charge and is labelled
// as a takeaway (it still carries the table_id / table_number).
export const createOrder = async (table_id, covers, staff_id, order_type = 'dine_in') => {
  try {
    return await post('/api/orders', { table_id, covers, staff_id, order_type });
  } catch (e) {
    if (!isNative()) throw e;   // web POS / desktop: original behaviour — never create a local order
    let table_number = table_id;
    try { const tbls = await cacheGet('/api/tables'); const t = (tbls || []).find(x => x.id === table_id); if (t) table_number = t.table_number; } catch {}
    const now = new Date().toISOString();
    const id = 'L' + Date.now();
    const doc = { id, table_id, table_number, covers, staff_id, status: 'open', total: 0,
      items: [], opened_at: now, created_at: now, order_type: order_type || 'dine_in', offline: true };
    await localOrderCreate(doc);
    return { id };
  }
};
// SEPOS-045 — counter mode: tableless order, paid at the till.
export const createCounterOrder = async (staff_id) => {
  try {
    return await post('/api/orders', { table_id: null, covers: 1, staff_id, order_type: 'counter' });
  } catch (e) {
    if (!isNative()) throw e;   // web POS / desktop: original behaviour
    const now = new Date().toISOString();
    const id = 'L' + Date.now();
    const doc = { id, table_id: null, table_number: null, covers: 1, staff_id, status: 'open',
      total: 0, items: [], opened_at: now, created_at: now, order_type: 'counter', offline: true };
    await localOrderCreate(doc);
    return { id };
  }
};
export const addOrderItems = async (orderId, items) => {
  const lid = await localTarget(orderId);
  if (lid) return localAppendItems(lid, items);
  try { return await post(`/api/orders/${orderId}/items`, { items }); }
  catch (e) {
    if (!isNative()) throw e;
    const pid = await promoteOrder(orderId);       // offline edit to a not-yet-promoted cloud table
    if (!pid) throw e;
    return localAppendItems(pid, items);
  }
};
// SEPOS-062 — `tenders` (optional) is an array of {amount, method} for split
// bills, so each tender is recorded as its own payment row with its real method
// (Cash/Card) instead of one lumped 'Split' row. Single payments omit it.
const localPay = async (lid, amount, method, tenders) => {
  const doc = await localOrderGet(lid);
  if (!doc) return { error: 'Order not found' };
  doc.status = 'closed';
  doc.payment_method = method;
  doc.amount_paid = amount;
  if (tenders && tenders.length) doc.tenders = tenders;
  doc.closed_at = new Date().toISOString();
  await localOrderUpdate(lid, doc);
  return { success: true };
};
export const payOrder = async (orderId, amount, method, tenders) => {
  const lid = await localTarget(orderId);
  if (lid) return localPay(lid, amount, method, tenders);
  try { return await post(`/api/orders/${orderId}/pay`, tenders && tenders.length ? { payments: tenders } : { amount, method }); }
  catch (e) {
    if (!isNative()) throw e;
    const pid = await promoteOrder(orderId);
    if (!pid) throw e;
    return localPay(pid, amount, method, tenders);
  }
};

// SEPOS-ANDROID-002 — replay engine. When back online, push every order that was
// created/edited offline up to the cloud, then mark it synced so the local copy
// drops off the floor and the cloud copy takes over. Reconstructs from the final
// state: create → add (non-voided) items → fire fired courses → pay/close.
// Safe to call repeatedly; a no-op when offline or nothing is pending. Each order
// is independent — one failure doesn't block the rest, it just retries next tick.
const _payCloud = async (cid, doc) => {
  if (doc.status !== 'closed') return;
  if (doc.payment_method === 'cancelled') await post(`/api/orders/${cid}/close-zero`, {});
  else if (doc.tenders && doc.tenders.length) await post(`/api/orders/${cid}/pay`, { payments: doc.tenders });
  else await post(`/api/orders/${cid}/pay`, { amount: doc.amount_paid ?? doc.total, method: doc.payment_method || 'Cash' });
};
// A brand-new offline order ('L…'): create it, then add items / fire / pay.
const syncNewLocal = async (doc) => {
  const created = await post('/api/orders', {
    table_id: doc.table_id, covers: doc.covers, staff_id: doc.staff_id,
    order_type: doc.order_type || 'dine_in',
  });
  if (!created || created.error || created.id == null) return false;  // cloud rejected — retry next tick
  const cid = created.id;
  const items = (doc.items || []).filter(i => !i.voided).map(i => ({
    menu_item_id: i.menu_item_id ?? null, name: i.name || i.item_name, name_alt: i.name_alt || '',
    quantity: i.quantity || 1, unit_price: i.unit_price ?? 0,
    notes: i.notes || '', item_note: i.item_note || '', course: i.course || 1, is_bar: !!i.is_bar, modifiers: i.modifiers || [],
  }));
  if (items.length) await post(`/api/orders/${cid}/items`, { items });
  const fired = [...new Set((doc.items || []).filter(i => i.is_fired && !i.voided).map(i => Number(i.course) || 1))];
  for (const c of fired) await put(`/api/orders/${cid}/fire-course/${c}`, {});
  await _payCloud(cid, doc);
  await localOrderMarkSynced(doc.id, cid);
  return true;
};
// A promoted cloud order: push only the offline DELTA to the existing cloud
// order (new items added, original items voided, courses fired, payment).
const syncPromoted = async (doc) => {
  const cid = doc.cloud_id;
  const newItems = (doc.items || []).filter(i => isLocalItemId(i.id) && !i.voided).map(i => ({
    menu_item_id: i.menu_item_id ?? null, name: i.name || i.item_name, name_alt: i.name_alt || '',
    quantity: i.quantity || 1, unit_price: i.unit_price ?? 0,
    notes: i.notes || '', item_note: i.item_note || '', course: i.course || 1, is_bar: !!i.is_bar, modifiers: i.modifiers || [],
  }));
  if (newItems.length) await post(`/api/orders/${cid}/items`, { items: newItems });
  // original (cloud-id) items the operator voided while offline
  for (const i of (doc.items || []).filter(i => !isLocalItemId(i.id) && i.voided)) {
    try { await put(`/api/order-items/${i.id}/void`, { reason: i.void_reason || 'Offline void' }); } catch {}
  }
  const fired = [...new Set((doc.items || []).filter(i => i.is_fired && !i.voided).map(i => Number(i.course) || 1))];
  for (const c of fired) { try { await put(`/api/orders/${cid}/fire-course/${c}`, {}); } catch {} }
  await _payCloud(cid, doc);
  await localOrderMarkSynced(doc.id, cid);
  return true;
};
let _syncing = false;
export async function syncLocalOrders() {
  if (_syncing) return { synced: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { synced: 0 };
  _syncing = true;
  let count = 0;
  try {
    const pending = await localOrderListUnsynced();
    for (const doc of pending) {
      try {
        const ok = doc.cloud_id != null ? await syncPromoted(doc) : await syncNewLocal(doc);
        if (ok) count++;
      } catch { /* leave this one unsynced; retry next tick */ }
    }
  } finally { _syncing = false; }
  return { synced: count };
}
export const updateItemStatus = async (itemId, status) => {
  // 'LI…' items, or items that live inside a promoted offline order, patch locally.
  if (isNative()) {
    const ok = await localItemPatch(itemId, { status, is_fired: 1 });
    if (ok) return { success: true };
  }
  return put(`/api/order-items/${itemId}/status`, { status });
};
// SEPOS-ANDROID-002 — offline PIN login. Online: validate at the cloud + cache
// the result keyed by a hash of the PIN. Offline: validate against that cache so
// staff who've signed in once on this device can still log in with no internet.
async function hashPin(pin) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('siampos-pin:' + pin));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'p:' + pin; }
}
export const loginStaff = async (pin) => {
  try {
    const json = useNativeHttp()
      ? await nativeRequest('POST', SERVER_URL + '/api/staff/login', { headers: { 'Content-Type': 'application/json', ...authHeaders() }, data: { pin } })
      : await (await fetch(SERVER_URL + '/api/staff/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ pin }),
        })).json();
    if (json && json.id && !json.error) hashPin(pin).then(h => cacheLogin(h, json)); // enable offline re-login
    return json;
  } catch (e) {
    const cached = await lookupLogin(await hashPin(pin));
    if (cached && cached.id) return { ...cached, offline: true };
    return { error: "No internet — and this PIN hasn't signed in on this device yet. Connect once, then it works offline." };
  }
};
// SEPOS-SEC-LOGIN — signed-in staff set their own PIN (forced off the default 1234).
export const changeStaffPin = (new_pin) => post('/api/staff/change-pin', { new_pin });
// SEPOS-LITE-003 — email + password login (Lite restaurant owners).
export const emailLogin = (email, password) => post('/api/auth/email-login', { email, password });
export const getDailyReport = (date) => get(`/api/reports/daily${date ? `?date=${date}` : ''}`);
export const getItemModifiers = async (itemId) => {
  if (!isNative()) return get(`/api/menu/items/${itemId}/modifiers`);   // web/desktop: unchanged
  try { const r = await get(`/api/menu/items/${itemId}/modifiers`); return Array.isArray(r) ? r : []; }
  catch { return []; }   // offline + uncached: no modifiers, but the item still adds
};
export const addModifierGroup = (itemId, group) => post(`/api/menu/items/${itemId}/modifiers`, group);
// SEPOS-ALLERGEN-OPT-001 — one-tap create of the global dietary/allergen group (idempotent server-side).
export const createDietaryPreset = () => post('/api/menu/dietary-preset', {});
export const addModifierOption = (groupId, option) => post(`/api/modifier-groups/${groupId}/options`, option);
export const deleteModifierGroup = (groupId) => del(`/api/modifier-groups/${groupId}`);
export const deleteModifier = (modifierId) => del(`/api/modifiers/${modifierId}`);
// SEPOS-059 — shared modifier library: reusable groups attached to many dishes.
export const getModifierLibrary  = () => get('/api/modifier-library');
export const createLibraryGroup  = (group) => post('/api/modifier-library', group);
export const attachGroupToItem   = (itemId, groupId) => post(`/api/menu/items/${itemId}/modifier-groups/${groupId}`, {});
export const detachGroupFromItem = (itemId, groupId) => del(`/api/menu/items/${itemId}/modifier-groups/${groupId}`);
export const voidItem = async (itemId, reason, quantity, void_type) => {
  // 'LI…' items, or items inside a promoted offline order, void locally (whole
  // line — partial-quantity void is a cloud-only refinement; total recomputes).
  if (isNative()) {
    const ok = await localItemPatch(itemId, { voided: 1, void_reason: reason || '', void_type: void_type || null });
    if (ok) return { success: true };
  }
  const body = { reason };
  if (quantity)  body.quantity  = quantity;
  if (void_type) body.void_type = void_type;
  return put(`/api/order-items/${itemId}/void`, body);
};
export const applyDiscount = async (orderId, discount_type, discount_value, discount_reason) => {
  const lid = await localTarget(orderId);
  if (lid) {
    const doc = await localOrderGet(lid);
    if (!doc) return { error: 'Order not found' };
    doc.discount_type = discount_type; doc.discount_value = discount_value; doc.discount_reason = discount_reason;
    await localOrderUpdate(lid, doc);
    return { success: true };
  }
  return put(`/api/orders/${orderId}/discount`, { discount_type, discount_value, discount_reason });
};
// SEPOS — persist per-order "Remove service charge" toggle so the Bill honours it.
export const setOrderServiceCharge = async (orderId, removed) => {
  const flag = removed ? 1 : 0;
  const lid = await localTarget(orderId);
  if (lid) {
    const doc = await localOrderGet(lid);
    if (!doc) return { error: 'Order not found' };
    doc.no_service_charge = flag;
    await localOrderUpdate(lid, doc);
    return { ok: true };
  }
  return put(`/api/orders/${orderId}/service-charge`, { no_service_charge: flag });
};
// SEPOS-VOUCHER-REMOVE-001 — undo a partial voucher redemption while bill is open
export const removeVoucherFromBill = async (orderId, code) =>
  (await localTarget(orderId)) ? { success: true } : post(`/api/orders/${orderId}/voucher-remove`, code ? { code } : {});
// SEPOS-CLOSE-ZERO — close an order that's at £0 (all voided / fully discounted)
export const closeOrderZero       = async (orderId) => {
  const lid = await localTarget(orderId);
  if (lid) {
    const doc = await localOrderGet(lid);
    if (!doc) return { error: 'Order not found' };
    doc.status = 'closed'; doc.amount_paid = 0; doc.payment_method = 'cancelled';
    doc.closed_at = new Date().toISOString();
    await localOrderUpdate(lid, doc);
    return { success: true };
  }
  return post(`/api/orders/${orderId}/close-zero`, {});
};
// SEPOS-PAY-AMEND-001 — change payment method on a closed bill (manager PIN)
export const amendBillMethod      = (orderId, body) => put(`/api/bills/${orderId}/amend-method`, body);
export const getBillAmendments    = (orderId) => get(`/api/bills/${orderId}/amendments`);
// SEPOS-BILLEDIT-001 — correct a wrong/duplicate paid amount on a closed bill.
// body: { payments: [{ id, amount, method, remove }], reason, pin }
export const editBillPayment      = (orderId, body) => put(`/api/bills/${orderId}/edit-payment`, body);
export const getSettings = () => get('/api/settings');
export const updateSettings = (settings) => put('/api/settings', settings);
// SEPOS-060 phase 2 — desktop offline license lock state + manual re-check
// (used by the lock screen after a client pays so they unlock without waiting).
export const getLicenseState = () => get('/api/license-state');
export const recheckLicense  = () => post('/api/license-recheck', {});
// SEPOS-LITE-001 — restaurant record incl. subscription plan.
export const getRestaurant = () => get('/api/restaurant');

// SEPOS-STATION-001 — extra printer stations (wok/grill/cold…) + category routing.
export const getPrinters        = () => get('/api/printers');
export const createPrinter      = (body) => post('/api/printers', body);
export const updatePrinter      = (id, body) => put(`/api/printers/${id}`, body);
export const deletePrinter      = (id) => del(`/api/printers/${id}`);
export const testPrinter        = (id) => post(`/api/printers/${id}/test`, {});
export const setCategoryPrinter = (id, printer_id) => put(`/api/categories/${id}/printer`, { printer_id });
// SEPOS-PRINT-UNIFY-001 — set the default printer for a role (receipt|kitchen|bar)
export const setPrinterDefault  = (role, printer_id) => post('/api/printers/set-default', { role, printer_id });
// SEPOS-PRINT-UNIFY-001 — scan the local network for printers on :9100 (local install only)
export const scanPrinters       = () => get('/api/printers/scan');
// SEPOS-DRAWER-001 — open the cash drawer (kick via the receipt printer) on payment
export const serverOpenDrawer   = (printer_name) => post('/api/print/drawer', printer_name ? { printer_name } : {});

// SIAMPAY-QR-001 — dine-in QR pay-by-link.
export const createQrPay  = (orderId, amount)     => post(`/api/orders/${orderId}/qr-pay`, { amount });
export const qrPayStatus  = (orderId, sessionId)  => get(`/api/orders/${orderId}/qr-pay/status?session_id=${encodeURIComponent(sessionId)}`);
// Print a dine-in kitchen ticket to a specific station (server routes by printer_id).
export const serverPrintKitchenToStation = (order_id, items, printer_id, printer_name) =>
  post('/api/print/kitchen-station', { order_id, items, printer_id, printer_name });

// SEPOS-025/026 — Network printing (server-side ESC/POS to TCP port 9100)
export const testNetworkPrinter   = (ip, port, printer_name) => post('/api/print/test',    { ip, port, printer_name });
// SEPOS-ANDROID-001 — ESC/POS buffers (base64) for the native app to send itself.
export const getPrintTestBuffer   = () => get('/api/print/buffers/test');
export const getReceiptBuffer     = (order_id, payment_details) => post('/api/print/buffers/receipt', { order_id, payment_details });
export const getKitchenBuffer     = (order_id) => post('/api/print/buffers/kitchen', { order_id });
// SEPOS-ANDROID-001 — dine-in kitchen/bar/fire-notice buffer (firing device pushes it to the LAN printer)
export const getKitchenTicketBuffer = ({ order_id, items, course, kind }) =>
  post('/api/print/buffers/kitchen-ticket', { order_id, items, course, kind });
export const cupsQueueForIp       = (ip) => get(`/api/print/cups-queue-for-ip?ip=${encodeURIComponent(ip)}`);
// SEPOS-PRINT-HEALTH-001 — TCP reachability check, returns { ok, latency_ms, error? }
export const printerHealth        = (ip, port) => get(`/api/print/health?ip=${encodeURIComponent(ip)}&port=${port || 9100}`);
// SEPOS-PRINT-MAC-001 — MAC ↔ IP discovery via ARP cache
export const printerGetMac        = (ip)  => get(`/api/print/get-mac?ip=${encodeURIComponent(ip)}`);
export const printerDiscover      = (mac) => get(`/api/print/discover?mac=${encodeURIComponent(mac)}`);
// SEPOS-PRINT-THAI-PROBE — visual codepage probe ticket
// Pass a cp number to test that specific codepage only; omit to sweep all.
export const printerThaiTest      = (cp = null, printer_name) => post('/api/print/thai-test', { ...(cp ? { cp } : {}), ...(printer_name ? { printer_name } : {}) });

// SEPOS-LOCAL-001 P1 — local HMRC archive status + manual triggers
export const getArchiveStatus     = () => get('/api/local/archive-status');
export const openArchiveFolder    = () => post('/api/local/archive-open-folder', {});
export const runArchive           = (date, force = false) => post('/api/local/archive-run', { date, force });

// SEPOS-LOCAL-001 P3/P5 — migration status + combined storage stats
export const getMigrationStatus   = () => get('/api/local/migration-status');
export const getStorageStats      = () => get('/api/local/storage-stats');

// SEPOS-LOCAL-001 P6 — Cloudflare Tunnel status (returns {enabled, status, remote_url})
export const getTunnelStatus      = () => get('/api/local/tunnel-status');

// SEPOS-KITCHEN-MSG-001 — pre-canned kitchen-message templates + send
export const getKitchenTemplates  = () => get('/api/kitchen-templates');
export const createKitchenTemplate = (body) => post('/api/kitchen-templates', body);
export const updateKitchenTemplate = (id, body) => put(`/api/kitchen-templates/${id}`, body);
export const deleteKitchenTemplate = (id) => del(`/api/kitchen-templates/${id}`);
export const sendKitchenMessage   = (body) => post('/api/print/kitchen-message', body);
// SEPOS-KITCHEN-MSG-002 — attach a kitchen note to the order (prints at the
// bottom of that order's kitchen ticket). Empty note clears it.
export const saveOrderNote        = (orderId, note) => put(`/api/orders/${orderId}/note`, { note });
// SEPOS-ANDROID-001 — kitchen-message buffer for the native app to print on-device
export const getKitchenMessageBuffer = (body) => post('/api/print/buffers/kitchen-message', body);
export const serverPrintReceipt   = (order_id, payment_details, printer_name, printer_id) => post('/api/print/receipt', { order_id, payment_details, printer_name, printer_id });
// SEPOS-REPORTS-001 — ESC/POS print for admin reports (Sales / Items /
// Z / VAT / Bills). Takes a line DSL — see printService.buildReportText.
export const serverPrintReportText = (lines) => post('/api/print/report-text', { lines });
export const serverPrintKitchen   = (order_id, items, course, printer_name, copies)   => post('/api/print/kitchen', { order_id, items, course, printer_name, copies });
export const serverPrintBar           = (order_id, items, printer_name)         => post('/api/print/bar',          { order_id, items, printer_name });
export const serverPrintKitchenFull   = (order_id, items, printer_name, copies)         => post('/api/print/kitchen-full', { order_id, items, printer_name, copies });
export const serverPrintFireNotice    = (order_id, course, printer_name)        => post('/api/print/kitchen-fire', { order_id, course, printer_name });
export const getDiscountReasons = () => get('/api/discount-reasons');
export const addDiscountReason = (reason) => post('/api/discount-reasons', { reason });
export const deleteDiscountReason = (id) => del(`/api/discount-reasons/${id}`);
export const getStaff = () => get('/api/staff');
export const addStaff = (staff) => post('/api/staff', staff);
export const updateStaff = (id, staff) => put(`/api/staff/${id}`, staff);
export const getSummaryReport = (from, to) => get(`/api/reports/summary?from=${from}&to=${to}`);
export const getItemSalesReport = (from, to) => get(`/api/reports/items?from=${from}&to=${to}`);
export const updateTablePlan = (id, data) => put(`/api/tables/${id}/plan`, data);
export const addTable = (table) => post('/api/tables', table);
export const deleteTable = (id) => del(`/api/tables/${id}`);
export const getBill = async (orderId) => {
  const lid = await localTarget(orderId);
  if (lid) {
    const order = await localOrderGet(lid);
    if (!order) return { error: 'Order not found' };
    let settings = {};
    try { settings = (await cacheGet('/api/settings')) || {}; } catch {}
    return { order, settings };
  }
  return get(`/api/orders/${orderId}/bill`);
};
export const getBarOrders = async () => {
  if (!isNative()) return get('/api/orders/bar');   // web/desktop: unchanged
  let base = [];
  try { base = await get('/api/orders/bar'); } catch {}
  let locals = [];
  try {
    const open = await localOrderListOpen();
    locals = open
      .map(o => ({ ...o, items: (o.items || []).filter(i => i.is_bar && i.is_fired && i.status !== 'served' && !i.voided) }))
      .filter(o => o.items.length);
  } catch {}
  const arr = Array.isArray(base) ? base : [];
  return locals.length ? [...arr, ...locals] : arr;
};
export const getCategories = () => get('/api/categories');
export const updateCategoryBar = (id, is_bar) => put(`/api/categories/${id}/bar`, { is_bar });
export const updateCategorySortOrder = (items) => put('/api/categories/sort-order', { items });
// Menu-item drag reorder — via the native-safe put() so it also persists on the
// Sunmi app (a raw fetch from the native WebView silently fails → reorder reverts).
export const updateMenuItemsSortOrder = (items) => put('/api/menu/items/sort-order', { items });
export const updateCategoryDefaultCourse = (id, default_course) => put(`/api/categories/${id}/default-course`, { default_course });
export const addCategory = (name) => post('/api/categories', { name });
export const updateCategory = (id, name) => put(`/api/categories/${id}`, { name });
export const deleteCategory = (id) => del(`/api/categories/${id}`);
export const getSubcategories = () => get('/api/subcategories');
export const addSubcategory = (category_id, name) => post('/api/subcategories', { category_id, name });
export const deleteSubcategory = (id) => del(`/api/subcategories/${id}`);
// SEPOS-046ab — same contract as updateCategorySortOrder
export const updateSubcategorySortOrder = (items) => put('/api/subcategories/sort-order', { items });
const localFire = async (lid, course) => {
  const doc = await localOrderGet(lid);
  if (!doc) return { error: 'Order not found' };
  (doc.items || []).forEach(it => {
    if (!it.voided && Number(it.course) === Number(course)) { it.is_fired = 1; it.status = 'cooking'; }
  });
  await localOrderUpdate(lid, doc);
  return { success: true };
};
export const fireCourse = async (orderId, course) => {
  const lid = await localTarget(orderId);
  if (lid) return localFire(lid, course);
  try { return await put(`/api/orders/${orderId}/fire-course/${course}`, {}); }
  catch (e) {
    if (!isNative()) throw e;
    const pid = await promoteOrder(orderId);
    if (!pid) throw e;
    return localFire(pid, course);
  }
};
export const getTableStatus = async () => {
  const base = await get('/api/tables/status');
  let locals = [];
  try { locals = await localOrderListOpen(); } catch {}
  if (!locals.length) return base;
  const arr = Array.isArray(base) ? [...base] : [];
  for (const o of locals) {
    if (o.table_id != null && !arr.some(s => s.table_id === o.table_id)) {
      const anyFired = (o.items || []).some(it => it.is_fired && !it.voided);
      arr.push({ table_id: o.table_id, colour_status: anyFired ? 'starters_fired' : 'occupied' });
    }
  }
  return arr;
};
export const markBillPrinted = async (orderId) =>
  (await localTarget(orderId)) ? { success: true } : put(`/api/orders/${orderId}/bill-printed`, {});
export const moveTable = async (orderId, newTableId) => {
  const lid = await localTarget(orderId);
  if (lid) {
    const doc = await localOrderGet(lid);
    if (!doc) return { error: 'Order not found' };
    doc.table_id = newTableId;
    try { const tbls = await cacheGet('/api/tables'); const t = (tbls || []).find(x => x.id === newTableId); if (t) doc.table_number = t.table_number; } catch {}
    await localOrderUpdate(lid, doc);
    return { success: true };
  }
  return put(`/api/orders/${orderId}/move`, { new_table_id: newTableId });
};
export const mergeTables = async (targetOrderId, mergeOrderId) => {
  const tl = await localTarget(targetOrderId);
  const ml = await localTarget(mergeOrderId);
  if (tl || ml) {
    if (!tl || !ml)
      return { error: 'Cannot merge an offline table with a cloud table until back online' };
    const tgt = await localOrderGet(tl);
    const mrg = await localOrderGet(ml);
    if (!tgt || !mrg) return { error: 'Order not found' };
    tgt.items = [...(tgt.items || []), ...(mrg.items || [])];
    tgt.total = tgt.items.filter(x => !x.voided).reduce((s, x) => s + (Number(x.unit_price) || 0) * (Number(x.quantity) || 1), 0);
    mrg.status = 'merged';
    await localOrderUpdate(tl, tgt);
    await localOrderUpdate(ml, mrg);
    return { success: true };
  }
  return put(`/api/orders/${targetOrderId}/merge`, { merge_order_id: mergeOrderId });
};
export const getZReportPreview = (from, to) => get(`/api/z-report/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const saveZReport = (type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, actual_card, card_difference) =>
  post('/api/z-report/save', { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, actual_card, card_difference });
export const getZReportHistory = () => get('/api/z-report/history');
// SEPOS-053 — till sessions (EposNow-style Open Shift → Close Shift)
export const getZReportPreviewBySession = (sessionId) => get(`/api/z-report/preview?session_id=${encodeURIComponent(sessionId)}`);
export const getCurrentSession = () => get('/api/till-sessions/current');
export const openSession  = (staff_id, float_amount) => post('/api/till-sessions/open', { staff_id, float_amount });
export const closeSession = (closed_by, z_report_id) => post('/api/till-sessions/close', { closed_by, z_report_id });
export const getBills = (from, to, method) => get(`/api/bills?from=${from}&to=${to}&method=${method}`);
export const getBillItems = (orderId) => get(`/api/bills/${orderId}/items`);
export const getKitchenCompleted = () => get('/api/kitchen/completed');
export const getBarCompleted = () => get('/api/bar/completed');
export const resendToKitchen = async (orderId, itemIds, reason) =>
  (await localTarget(orderId)) ? { success: true } : post(`/api/orders/${orderId}/resend`, { item_ids: itemIds, reason });
export const applyItemDiscount = async (itemId, discount_type, discount_value) => {
  if (isNative()) {
    const ok = await localItemPatch(itemId, { discount_type, discount_value });
    if (ok) return { success: true };
  }
  return put(`/api/order-items/${itemId}/discount`, { discount_type, discount_value });
};
export const deleteStaff = (id) => del(`/api/staff/${id}`);
// ─────────────────────────────────────────────
// MENU BATCH IMPORT
// ─────────────────────────────────────────────

export const importMenuBatch = async (items) => {
  if (useNativeHttp())
    return nativeRequest('POST', `${SERVER_URL}/api/menu/import-batch`, { headers: { 'Content-Type': 'application/json' }, data: { items } });
  const res = await fetch(`${SERVER_URL}/api/menu/import-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  return res.json();
};
export const deleteMenuItem = async (id) => {
  if (useNativeHttp())
    return nativeRequest('DELETE', `${SERVER_URL}/api/menu/items/${id}`, {});
  const res = await fetch(`${SERVER_URL}/api/menu/items/${id}`, {
    method: 'DELETE',
  });
  return res.json();
};
// ─────────────────────────────────────────────────────────────────────
// Add these exports to the bottom of api.js
// ─────────────────────────────────────────────────────────────────────

// Table Combinations
export const getTableCombinations = () => get('/api/table-combinations');
export const addTableCombination = (table_id_a, table_id_b) => post('/api/table-combinations', { table_id_a, table_id_b });
export const deleteTableCombination = (id) => del(`/api/table-combinations/${id}`);

// Table Walls
export const getTableWalls = () => get('/api/table-walls');
export const addTableWall = (wall) => post('/api/table-walls', wall);
export const updateTableWall = (id, wall) => put(`/api/table-walls/${id}`, wall);
export const deleteTableWall = (id) => del(`/api/table-walls/${id}`);

// Dining Duration Tiers
export const getDiningDurationTiers = () => get('/api/dining-duration-tiers');
export const updateDiningDurationTiers = (tiers) => put('/api/dining-duration-tiers', { tiers });

// Network setup — LAN address the iPads should connect to.
export const getNetworkInfo = () => get('/api/network-info');

// SEPOS-022 — staff clock-in / clock-out
export const clockIn        = (pin)        => post('/api/clock/in',  { pin });
export const clockOut       = (pin)        => post('/api/clock/out', { pin });
export const clockToggle    = (pin)        => post('/api/clock/toggle', { pin }); // SEPOS-CLOCK-002 — auto in/out
export const getClockStatus = ()           => get('/api/clock/status');
export const getClockRecords = (from, to)  => get(`/api/clock/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// SEPOS-030 — staff performance report
export const getStaffPerformance = (from, to) =>
  get(`/api/reports/staff-performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// SEPOS-021 — VAT report (date range)
export const getVatReport = (from, to) =>
  get(`/api/reports/vat?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// SEPOS-031 — wastage cost report (date range)
export const getWastageReport = (from, to) =>
  get(`/api/reports/wastage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
// SEPOS-MENUPERF-001 — per-dish sales vs recipe cost (menu performance A4 print)
export const getMenuPerformance = (from, to) =>
  get(`/api/reports/menu-performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// SEPOS-033 — customer CRM (Phase 1)
export const getCustomers = () => get('/api/customers');
export const setCustomerConsent = (email, consent) =>
  put('/api/customers/marketing-consent', { email, consent });
// SEPOS-056 — delete customers (one or many emails). The CRM is derived,
// so the server removes their reservations and clears their PII from
// takeaway orders.
// contacts: [{ email, phone }] — deletes by email, or by phone for phone-only customers.
export const deleteCustomers = (contacts) => post('/api/customers/delete', { contacts });

// SEPOS-033 Phase 2 — email campaigns
export const getCampaigns      = ()                    => get('/api/campaigns');
export const getRecipientCount = (segment)             => get(`/api/campaigns/recipient-count?segment=${encodeURIComponent(segment)}`);
export const sendCampaign      = (subject, body, segment) => post('/api/campaigns/send', { subject, body, segment });

// SEPOS-034 — takeaway lifecycle (pending → accepted → preparing → ready → collected).
// Marking 'collected' on the cloud closes the order and stamps closed_at, which
// is what flips it into the Daily report / Z report / Bills tab.
export const setTakeawayStatus = (orderId, status) =>
  put(`/api/orders/${orderId}/takeaway-status`, { status });

// SEPOS-034 — active takeaway list (drives the strip on the table-map screen).
export const getActiveTakeaway = () => get('/api/takeaway/orders/active');

// SEPOS-DELIVERY-001 — courier dispatch (Stuart / Uber Direct).
export const dispatchDelivery = async (orderId) =>
  (await localTarget(orderId)) ? { success: true } : post('/api/delivery/dispatch', { order_id: orderId });
export const getDeliveryQuote = (orderId) => post('/api/delivery/quote', { order_id: orderId });

// SEPOS-044 — Floor-Plan polish: seat a booking or a walk-in.
// Both endpoints return { reservation, order } where order is the newly
// opened dine-in order on the table (id used to navigate to OrderScreen).
export const seatReservation = (id, body) =>
  post(`/api/reservations/${id}/seat`, body || {});
export const seatWalkIn = (body) => post('/api/reservations/walk-in', body);

// SEPOS-044 — minimal reservations list helper. ReservationsScreen has its
// own fetch path; this one is for the table-map pre-claim badges, where we
// only need today's bookings.
export const getReservations = () => get('/api/reservations');

// SEPOS-044 — sync health probe. Used by TableMapScreen to show a banner
// when the Mac is in local mode without SYNC_SECRET (silent delete-drop
// risk) or when the queue is backing up.
export const getSyncHealth = () => get('/api/sync/health');

// SEPOS-AI-HELP-001 — in-app "Ask AI" help assistant. messages = [{role,content}].
export const askAi = (messages, platform) => post('/api/ai/help', { messages, platform });

// SEPOS-044 follow-up — sync queue inspector (local mode only).
export const getSyncQueue = () => get('/api/sync/queue');
export const skipSyncQueueEntry = (id) => post(`/api/sync/queue/${id}/skip`, {});
export const runSyncNow = () => post('/api/sync/run-now', {});

// SEPOS-042 — manager-gated order deletion. Used by Admin → Bills → Delete.
// Backend requires PIN to belong to a staff row with role manager/admin/supervisor,
// writes an audit row to order_deletions, then cascade-deletes the order.
export const deleteOrder = (orderId, pin, reason) =>
  useNativeHttp()
    ? nativeRequest('DELETE', `${SERVER_URL}/api/orders/${orderId}`, { headers: { 'Content-Type': 'application/json' }, data: { pin, reason } })
    : fetch(`${SERVER_URL}/api/orders/${orderId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, reason }),
      }).then(r => r.json());

// ── SEPOS-VOUCHER-001 — gift voucher API ─────────────────────────
export const getVoucher    = (code) => get(`/api/widget/voucher/${encodeURIComponent(code)}`);
export const redeemVoucher = (code, amount, bill_id, redeemed_by) =>
  post(`/api/vouchers/${encodeURIComponent(code)}/redeem`, { amount, bill_id, redeemed_by });
export const listVouchers  = (q, status) => {
  const qs = new URLSearchParams();
  if (q)      qs.set('q', q);
  if (status) qs.set('status', status);
  const s = qs.toString();
  return get('/api/vouchers' + (s ? `?${s}` : ''));
};
export const getVoucherDetail   = (id) => get(`/api/vouchers/${id}`);
export const voidVoucher        = (id, voided_by) => post(`/api/vouchers/${id}/void`, { voided_by });
export const resendVoucherEmail = (id) => post(`/api/vouchers/${id}/resend-email`, {});
export const sellVoucher        = (body) => post('/api/vouchers/sell', body);

// ── SEPOS-DEPOSIT-001 — booking deposits (typed vouchers, redeemed as a tender) ──
export const createDeposit   = (body) => post('/api/deposits', body);
export const getOrderDeposit = (orderId) => get(`/api/orders/${orderId}/deposit`);
// Manual forfeit of a no-show's deposit (kept as income).
export const forfeitDeposit  = (code) => post(`/api/deposits/${encodeURIComponent(code)}/forfeit`, {});

// ── SEPOS-PRINT-ALERT-001 — held tickets + printer health (local tills) ──
export const getPrintAlerts    = () => get('/api/print/alerts');
export const printAlertAction  = (action, ids) => post('/api/print/alerts/action', { action, ids });
