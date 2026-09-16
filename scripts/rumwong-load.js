// Load the Rumwong menu + tables into the fresh tenant. Idempotent-ish: refuses
// to run if the tenant already has categories (so it can't double-load).
const { CATS } = require('./rumwong-menu-spec.js');
const B = process.env.B || 'https://siamepos-rumwong-production.up.railway.app';
const j = async (path, method = 'GET', body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 200)}`);
  return d;
};
(async () => {
  const existing = await j('/api/categories');
  if (Array.isArray(existing) && existing.length) { console.error('tenant already has', existing.length, 'categories — aborting'); process.exit(1); }
  let items = 0, groups = 0;
  for (const c of CATS) {
    const cat = await j('/api/categories', 'POST', { name: c.name });
    await j(`/api/categories/${cat.id}/bar`, 'PUT', { is_bar: c.is_bar });
    await j(`/api/categories/${cat.id}/default-course`, 'PUT', { default_course: c.course });
    for (const it of c.items) {
      const r = await j('/api/menu/items', 'POST', { category_id: cat.id, name: it.name, price: it.price, vat_rate: 20, allergens: it.allergens || undefined });
      const id = r.id || (r.item && r.item.id);
      items += 1;
      for (const g of it.modifiers) {
        const gr = await j(`/api/menu/items/${id}/modifiers`, 'POST', { name: g.name, required: g.required ? 1 : 0, multi_select: g.multi_select ? 1 : 0 });
        const gid = gr.id || (gr.group && gr.group.id);
        for (const o of g.options) await j(`/api/modifier-groups/${gid}/options`, 'POST', { name: o.name, extra_price: o.extra_price });
        groups += 1;
      }
    }
    console.log(`✓ ${c.name} (${c.items.length})`);
  }
  // Tables — 150 covers per Harden's; a sensible starting plan the owner will rearrange.
  // 20 dine-in in a 5×4 grid + 1 takeaway slot (renamed per SEPOS-TA-LABEL rules).
  for (let n = 1; n <= 20; n++) {
    await j('/api/tables', 'POST', { table_number: String(n), capacity: n <= 10 ? 2 : n <= 16 ? 4 : 6, pos_x: 60 + ((n - 1) % 5) * 140, pos_y: 60 + Math.floor((n - 1) / 5) * 130, shape: n > 16 ? 'rect' : 'round', is_takeaway: 0 });
  }
  await j('/api/tables', 'POST', { table_number: 'Takeaway 1', capacity: 0, pos_x: 60, pos_y: 600, shape: 'rect', is_takeaway: 1 });
  console.log(`DONE: ${CATS.length} categories, ${items} items, ${groups} modifier groups, 20 tables + 1 takeaway`);
})().catch((e) => { console.error(e.message); process.exit(1); });
