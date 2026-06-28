import { cachePut, cacheGet, cacheLogin, lookupLogin } from './native/localdb';

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
  // Per-client Netlify deploy: set VITE_API_URL env var to override
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  // Otherwise use cloud
  return 'https://restaurant-epos-production.up.railway.app';
};

export const SERVER_URL = getServerURL();

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
    const r = await fetch(SERVER_URL + url, { headers: authHeaders() });
    const json = await r.json();
    if (json && !json.error) cachePut(url, json);   // fire-and-forget
    return json;
  } catch (e) {
    const cached = await cacheGet(url);
    if (cached !== undefined) return cached;
    throw e;
  }
};
const post = (url, data) => fetch(SERVER_URL + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
  body: JSON.stringify(data)
}).then(r => r.json());
const put = (url, data) => fetch(SERVER_URL + url, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
  body: JSON.stringify(data)
}).then(r => r.json());
const del = (url) => fetch(SERVER_URL + url, { method: 'DELETE', headers: authHeaders() }).then(r => r.json());

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
export const getMenu = () => get('/api/menu');
export const getAllMenu = () => get('/api/menu/all');
export const addMenuItem = (item) => post('/api/menu/items', item);
export const updateMenuItem = (id, item) => put(`/api/menu/items/${id}`, item);
export const getOrders = () => get('/api/orders');
export const getOrder = (id) => get(`/api/orders/${id}`);
export const createOrder = (table_id, covers, staff_id) => post('/api/orders', { table_id, covers, staff_id });
// SEPOS-045 — counter mode: tableless order, paid at the till.
export const createCounterOrder = (staff_id) =>
  post('/api/orders', { table_id: null, covers: 1, staff_id, order_type: 'counter' });
export const addOrderItems = (orderId, items) => post(`/api/orders/${orderId}/items`, { items });
// SEPOS-062 — `tenders` (optional) is an array of {amount, method} for split
// bills, so each tender is recorded as its own payment row with its real method
// (Cash/Card) instead of one lumped 'Split' row. Single payments omit it.
export const payOrder = (orderId, amount, method, tenders) =>
  post(`/api/orders/${orderId}/pay`, tenders && tenders.length ? { payments: tenders } : { amount, method });
export const updateItemStatus = (itemId, status) => put(`/api/order-items/${itemId}/status`, { status });
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
    const r = await fetch(SERVER_URL + '/api/staff/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ pin }),
    });
    const json = await r.json();
    if (json && json.id && !json.error) hashPin(pin).then(h => cacheLogin(h, json)); // enable offline re-login
    return json;
  } catch (e) {
    const cached = await lookupLogin(await hashPin(pin));
    if (cached && cached.id) return { ...cached, offline: true };
    return { error: "No internet — and this PIN hasn't signed in on this device yet. Connect once, then it works offline." };
  }
};
// SEPOS-LITE-003 — email + password login (Lite restaurant owners).
export const emailLogin = (email, password) => post('/api/auth/email-login', { email, password });
export const getDailyReport = (date) => get(`/api/reports/daily${date ? `?date=${date}` : ''}`);
export const getItemModifiers = (itemId) => get(`/api/menu/items/${itemId}/modifiers`);
export const addModifierGroup = (itemId, group) => post(`/api/menu/items/${itemId}/modifiers`, group);
export const addModifierOption = (groupId, option) => post(`/api/modifier-groups/${groupId}/options`, option);
export const deleteModifierGroup = (groupId) => del(`/api/modifier-groups/${groupId}`);
export const deleteModifier = (modifierId) => del(`/api/modifiers/${modifierId}`);
// SEPOS-059 — shared modifier library: reusable groups attached to many dishes.
export const getModifierLibrary  = () => get('/api/modifier-library');
export const createLibraryGroup  = (group) => post('/api/modifier-library', group);
export const attachGroupToItem   = (itemId, groupId) => post(`/api/menu/items/${itemId}/modifier-groups/${groupId}`, {});
export const detachGroupFromItem = (itemId, groupId) => del(`/api/menu/items/${itemId}/modifier-groups/${groupId}`);
export const voidItem = (itemId, reason, quantity, void_type) => {
  const body = { reason };
  if (quantity)  body.quantity  = quantity;
  if (void_type) body.void_type = void_type;
  return put(`/api/order-items/${itemId}/void`, body);
};
export const applyDiscount = (orderId, discount_type, discount_value, discount_reason) => put(`/api/orders/${orderId}/discount`, { discount_type, discount_value, discount_reason });
// SEPOS-VOUCHER-REMOVE-001 — undo a partial voucher redemption while bill is open
export const removeVoucherFromBill = (orderId) => post(`/api/orders/${orderId}/voucher-remove`, {});
// SEPOS-CLOSE-ZERO — close an order that's at £0 (all voided / fully discounted)
export const closeOrderZero       = (orderId) => post(`/api/orders/${orderId}/close-zero`, {});
// SEPOS-PAY-AMEND-001 — change payment method on a closed bill (manager PIN)
export const amendBillMethod      = (orderId, body) => put(`/api/bills/${orderId}/amend-method`, body);
export const getBillAmendments    = (orderId) => get(`/api/bills/${orderId}/amendments`);
export const getSettings = () => get('/api/settings');
export const updateSettings = (settings) => put('/api/settings', settings);
// SEPOS-060 phase 2 — desktop offline license lock state + manual re-check
// (used by the lock screen after a client pays so they unlock without waiting).
export const getLicenseState = () => get('/api/license-state');
export const recheckLicense  = () => post('/api/license-recheck', {});
// SEPOS-LITE-001 — restaurant record incl. subscription plan.
export const getRestaurant = () => get('/api/restaurant');

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
// SEPOS-ANDROID-001 — kitchen-message buffer for the native app to print on-device
export const getKitchenMessageBuffer = (body) => post('/api/print/buffers/kitchen-message', body);
export const serverPrintReceipt   = (order_id, payment_details, printer_name) => post('/api/print/receipt', { order_id, payment_details, printer_name });
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
export const getBill = (orderId) => get(`/api/orders/${orderId}/bill`);
export const getBarOrders = () => get('/api/orders/bar');
export const getCategories = () => get('/api/categories');
export const updateCategoryBar = (id, is_bar) => put(`/api/categories/${id}/bar`, { is_bar });
export const updateCategorySortOrder = (items) => put('/api/categories/sort-order', { items });
export const updateCategoryDefaultCourse = (id, default_course) => put(`/api/categories/${id}/default-course`, { default_course });
export const addCategory = (name) => post('/api/categories', { name });
export const updateCategory = (id, name) => put(`/api/categories/${id}`, { name });
export const deleteCategory = (id) => del(`/api/categories/${id}`);
export const getSubcategories = () => get('/api/subcategories');
export const addSubcategory = (category_id, name) => post('/api/subcategories', { category_id, name });
export const deleteSubcategory = (id) => del(`/api/subcategories/${id}`);
// SEPOS-046ab — same contract as updateCategorySortOrder
export const updateSubcategorySortOrder = (items) => put('/api/subcategories/sort-order', { items });
export const fireCourse = (orderId, course) => put(`/api/orders/${orderId}/fire-course/${course}`, {});
export const getTableStatus = () => get('/api/tables/status');
export const markBillPrinted = (orderId) => put(`/api/orders/${orderId}/bill-printed`, {});
export const moveTable = (orderId, newTableId) => put(`/api/orders/${orderId}/move`, { new_table_id: newTableId });
export const mergeTables = (targetOrderId, mergeOrderId) => put(`/api/orders/${targetOrderId}/merge`, { merge_order_id: mergeOrderId });
export const getZReportPreview = (from, to) => get(`/api/z-report/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const saveZReport = (type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference) => 
  post('/api/z-report/save', { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference });
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
export const resendToKitchen = (orderId, itemIds, reason) =>
  post(`/api/orders/${orderId}/resend`, { item_ids: itemIds, reason });
export const applyItemDiscount = (itemId, discount_type, discount_value) => put(`/api/order-items/${itemId}/discount`, { discount_type, discount_value });
export const deleteStaff = (id) => del(`/api/staff/${id}`);
// ─────────────────────────────────────────────
// MENU BATCH IMPORT
// ─────────────────────────────────────────────

export const importMenuBatch = async (items) => {
  const res = await fetch(`${SERVER_URL}/api/menu/import-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  return res.json();
};
export const deleteMenuItem = async (id) => {
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

// SEPOS-033 — customer CRM (Phase 1)
export const getCustomers = () => get('/api/customers');
export const setCustomerConsent = (email, consent) =>
  put('/api/customers/marketing-consent', { email, consent });
// SEPOS-056 — delete customers (one or many emails). The CRM is derived,
// so the server removes their reservations and clears their PII from
// takeaway orders.
export const deleteCustomers = (emails) => post('/api/customers/delete', { emails });

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
export const dispatchDelivery = (orderId) => post('/api/delivery/dispatch', { order_id: orderId });
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

// SEPOS-044 follow-up — sync queue inspector (local mode only).
export const getSyncQueue = () => get('/api/sync/queue');
export const skipSyncQueueEntry = (id) => post(`/api/sync/queue/${id}/skip`, {});
export const runSyncNow = () => post('/api/sync/run-now', {});

// SEPOS-042 — manager-gated order deletion. Used by Admin → Bills → Delete.
// Backend requires PIN to belong to a staff row with role manager/admin/supervisor,
// writes an audit row to order_deletions, then cascade-deletes the order.
export const deleteOrder = (orderId, pin, reason) =>
  fetch(`${SERVER_URL}/api/orders/${orderId}`, {
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
