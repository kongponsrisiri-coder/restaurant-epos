// Ma-prang demo tenant — clone the Baan Siam demo menu (categories, items,
// per-item modifier groups), a clean 20-table plan + takeaway, staff and the
// key settings into the fresh tenant. Refuses to run if categories exist.
// Usage: node scripts/maprang-demo-load.js   (reads scripts/.secrets-maprang-demo-config.json for the sync secret)
const SRC = 'https://baan-siam.siamepos.co.uk';
const cfg = require('./.secrets-maprang-demo-config.json');
const B = cfg.cloud_api_url;
const j = async (base, path, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 200)}`);
  return d;
};
const S = { 'x-sync-secret': cfg.sync_secret };
(async () => {
  const existing = await j(B, '/api/categories');
  if (Array.isArray(existing) && existing.length) throw new Error(`tenant already has ${existing.length} categories — refusing`);
  const menu = await j(SRC, '/api/menu');
  let items = 0, groups = 0;
  for (const c of menu) {
    const cat = await j(B, '/api/categories', 'POST', { name: c.name });
    await j(B, `/api/categories/${cat.id}/bar`, 'PUT', { is_bar: c.is_bar ? 1 : 0 });
    if (c.default_course) await j(B, `/api/categories/${cat.id}/default-course`, 'PUT', { default_course: c.default_course });
    const all = [...(c.items || []), ...((c.subcategories || []).flatMap(s => s.items || []))];
    for (const it of all) {
      const r = await j(B, '/api/menu/items', 'POST', { category_id: cat.id, name: it.name, name_alt: it.name_alt, description: it.description, price: Number(it.price), vat_rate: Number(it.vat_rate) || 20, allergens: it.allergens ? JSON.parse(it.allergens) : null, default_course: it.default_course });
      items++;
      const mods = await j(SRC, `/api/menu/items/${it.id}/modifiers`);
      for (const g of mods.filter(g => !g.is_global && g.menu_item_id === it.id)) {
        const gr = await j(B, `/api/menu/items/${r.id}/modifiers`, 'POST', { name: g.name, required: g.required ? 1 : 0, multi_select: g.multi_select ? 1 : 0 });
        for (const o of g.modifiers || []) await j(B, `/api/modifier-groups/${gr.id}/options`, 'POST', { name: o.name, extra_price: Number(o.extra_price) || 0 });
        groups++;
      }
    }
    console.log(`✓ ${c.name} (${all.length})`);
  }
  for (let n = 1; n <= 20; n++) {
    await j(B, '/api/tables', 'POST', { table_number: String(n), capacity: n <= 10 ? 2 : n <= 16 ? 4 : 6, pos_x: 60 + ((n - 1) % 5) * 140, pos_y: 60 + Math.floor((n - 1) / 5) * 130, shape: n > 16 ? 'rect' : 'round', is_takeaway: 0 });
  }
  await j(B, '/api/tables', 'POST', { table_number: 'Takeaway 1', capacity: 0, pos_x: 60, pos_y: 600, shape: 'rect', is_takeaway: 1 });
  // Staff for the demo (owner PIN comes from set-credentials, run separately)
  for (const s of [['Waiter', '1111', 'waiter'], ['Chef', '2222', 'kitchen'], ['Manager', '3333', 'manager']]) {
    await j(B, '/api/staff', 'POST', { name: s[0], pin: s[1], role: s[2], employment_status: 'active' }, S);
  }
  // Key settings copied from the demo (service charge etc.) — only the operational ones.
  const src = await j(SRC, '/api/settings');
  const keys = ['service_charge_rate', 'service_charge_enabled', 'receipt_footer', 'takeaway_pay_mode', 'qr_payment_policy', 'login_pin_only', 'kitchen_bar_as_waiters', 'nav_show_tables', 'nav_show_counter', 'restaurant_name'];
  const upd = {}; for (const k of keys) if (src[k] != null) upd[k] = src[k];
  upd.restaurant_name = 'Baan Siam';
  await j(B, '/api/settings', 'PUT', upd, S);
  console.log(`DONE: ${menu.length} categories, ${items} items, ${groups} modifier groups, 20 tables + 1 takeaway, 3 staff, ${Object.keys(upd).length} settings`);
})().catch((e) => { console.error(e.message); process.exit(1); });
