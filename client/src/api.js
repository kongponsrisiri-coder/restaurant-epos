const getServerURL = () => {
  // Electron desktop: the bundled local server lives on :3001 regardless of
  // how the renderer was loaded (file:// in prod, http://localhost:5173 in dev).
  // window.siamepos is injected by electron/preload.js.
  if (typeof window !== 'undefined' && window.siamepos && window.siamepos.isElectron) {
    return 'http://localhost:3001';
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
  // Otherwise use cloud
  return 'https://restaurant-epos-production.up.railway.app';
};

export const SERVER_URL = getServerURL();

const get = (url) => fetch(SERVER_URL + url).then(r => r.json());
const post = (url, data) => fetch(SERVER_URL + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
}).then(r => r.json());
const put = (url, data) => fetch(SERVER_URL + url, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
}).then(r => r.json());
const del = (url) => fetch(SERVER_URL + url, { method: 'DELETE' }).then(r => r.json());

export const getTables = () => get('/api/tables');
export const updateTableStatus = (id, status) => put(`/api/tables/${id}`, { status });
export const getMenu = () => get('/api/menu');
export const getAllMenu = () => get('/api/menu/all');
export const addMenuItem = (item) => post('/api/menu/items', item);
export const updateMenuItem = (id, item) => put(`/api/menu/items/${id}`, item);
export const getOrders = () => get('/api/orders');
export const getOrder = (id) => get(`/api/orders/${id}`);
export const createOrder = (table_id, covers, staff_id) => post('/api/orders', { table_id, covers, staff_id });
export const addOrderItems = (orderId, items) => post(`/api/orders/${orderId}/items`, { items });
export const payOrder = (orderId, amount, method) => post(`/api/orders/${orderId}/pay`, { amount, method });
export const updateItemStatus = (itemId, status) => put(`/api/order-items/${itemId}/status`, { status });
export const loginStaff = (pin) => post('/api/staff/login', { pin });
export const getDailyReport = (date) => get(`/api/reports/daily${date ? `?date=${date}` : ''}`);
export const getItemModifiers = (itemId) => get(`/api/menu/items/${itemId}/modifiers`);
export const addModifierGroup = (itemId, group) => post(`/api/menu/items/${itemId}/modifiers`, group);
export const addModifierOption = (groupId, option) => post(`/api/modifier-groups/${groupId}/options`, option);
export const deleteModifierGroup = (groupId) => del(`/api/modifier-groups/${groupId}`);
export const deleteModifier = (modifierId) => del(`/api/modifiers/${modifierId}`);
export const voidItem = (itemId, reason, quantity, void_type) => {
  const body = { reason };
  if (quantity)  body.quantity  = quantity;
  if (void_type) body.void_type = void_type;
  return put(`/api/order-items/${itemId}/void`, body);
};
export const applyDiscount = (orderId, discount_type, discount_value, discount_reason) => put(`/api/orders/${orderId}/discount`, { discount_type, discount_value, discount_reason });
export const getSettings = () => get('/api/settings');
export const updateSettings = (settings) => put('/api/settings', settings);
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
export const updateCategoryDefaultCourse = (id, default_course) => put(`/api/categories/${id}/default-course`, { default_course });
export const getSubcategories = () => get('/api/subcategories');
export const addSubcategory = (category_id, name) => post('/api/subcategories', { category_id, name });
export const deleteSubcategory = (id) => del(`/api/subcategories/${id}`);
export const fireCourse = (orderId, course) => put(`/api/orders/${orderId}/fire-course/${course}`, {});
export const getTableStatus = () => get('/api/tables/status');
export const markBillPrinted = (orderId) => put(`/api/orders/${orderId}/bill-printed`, {});
export const moveTable = (orderId, newTableId) => put(`/api/orders/${orderId}/move`, { new_table_id: newTableId });
export const mergeTables = (targetOrderId, mergeOrderId) => put(`/api/orders/${targetOrderId}/merge`, { merge_order_id: mergeOrderId });
export const getZReportPreview = (from, to) => get(`/api/z-report/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const saveZReport = (type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference) => 
  post('/api/z-report/save', { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference });
export const getZReportHistory = () => get('/api/z-report/history');
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
