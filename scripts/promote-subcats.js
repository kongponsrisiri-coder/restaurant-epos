// FERN-MENU-FLATTEN-001 — promote subcategories to top-level categories.
// Each subcategory becomes a category inheriting its parent's routing flags
// (is_bar, default_course, printer_id, color); its items follow; the empty
// subcategory row is deleted. Parents left with no items and no subs are
// deleted too (reported). Category sort order = parents in their old order,
// each followed by its promoted children.
//
// Usage: node promote-subcats.js                 → DRY RUN (prints plan)
//        node promote-subcats.js --execute       → do it, in a transaction
//        node promote-subcats.js --only-sub=ID   → limit to one subcategory
//        node promote-subcats.js --keep-empty-parents
// Env: DATABASE_PUBLIC_URL or DATABASE_URL (via `railway run`).
// Writes a pre-change snapshot JSON next to this script before executing.
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const EXECUTE = process.argv.includes('--execute');
const KEEP_EMPTY = process.argv.includes('--keep-empty-parents');
const onlyArg = process.argv.find(a => a.startsWith('--only-sub='));
const ONLY_SUB = onlyArg ? Number(onlyArg.split('=')[1]) : null;

const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const cats = (await pool.query(`SELECT * FROM categories ORDER BY sort_order, id`)).rows;
  const subs = (await pool.query(`SELECT * FROM subcategories ORDER BY category_id, sort_order, id`)).rows;
  const itemStats = (await pool.query(
    `SELECT subcategory_id, COUNT(*)::int AS n FROM menu_items WHERE subcategory_id IS NOT NULL GROUP BY subcategory_id`)).rows;
  const directStats = (await pool.query(
    `SELECT category_id, COUNT(*)::int AS n FROM menu_items WHERE subcategory_id IS NULL AND category_id IS NOT NULL GROUP BY category_id`)).rows;
  const nBySub = Object.fromEntries(itemStats.map(r => [r.subcategory_id, r.n]));
  const nDirect = Object.fromEntries(directStats.map(r => [r.category_id, r.n]));
  const totalItems = (await pool.query(`SELECT COUNT(*)::int AS n FROM menu_items`)).rows[0].n;

  const targets = subs.filter(s => ONLY_SUB == null || s.id === ONLY_SUB);
  if (!targets.length) { console.log('No subcategories to promote. Done.'); await pool.end(); return; }

  const catNames = new Set(cats.map(c => c.name.trim().toLowerCase()));
  console.log(`categories: ${cats.length} · subcategories: ${subs.length} (promoting ${targets.length}) · menu items: ${totalItems}`);
  console.log('--- plan ---');
  const plan = [];
  for (const c of cats) {
    const children = targets.filter(s => s.category_id === c.id);
    if (!children.length) continue;
    for (const s of children) {
      const clash = catNames.has(s.name.trim().toLowerCase());
      plan.push({ sub: s, parent: c });
      console.log(`  "${s.name}" (sub #${s.id}, ${nBySub[s.id] || 0} items) → new category after "${c.name}" [is_bar=${c.is_bar} course=${c.default_course} printer=${c.printer_id ?? '—'} color=${c.color ?? '—'}]${clash ? '  ⚠️ NAME CLASH with an existing category' : ''}`);
    }
    const remainingSubs = subs.filter(s => s.category_id === c.id && !children.includes(s)).length;
    const willBeEmpty = (nDirect[c.id] || 0) === 0 && remainingSubs === 0;
    if (willBeEmpty) console.log(`  parent "${c.name}" ends EMPTY → ${KEEP_EMPTY ? 'kept (flag)' : 'will be deleted'}`);
  }
  if (!EXECUTE) { console.log('--- DRY RUN — no changes made. Re-run with --execute ---'); await pool.end(); return; }

  // Snapshot before touching anything
  const snap = {
    when: new Date().toISOString(), totalItems,
    categories: cats, subcategories: subs,
    item_map: (await pool.query(`SELECT id, category_id, subcategory_id FROM menu_items`)).rows,
  };
  const snapFile = path.join(__dirname, `menu-snapshot-${Date.now()}.json`);
  fs.writeFileSync(snapFile, JSON.stringify(snap));
  console.log('snapshot →', snapFile);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let sort = 0;
    const emptyParents = [];
    for (const c of cats) {
      await client.query(`UPDATE categories SET sort_order = $1 WHERE id = $2`, [sort++, c.id]);
      const children = plan.filter(p => p.parent.id === c.id);
      for (const { sub } of children) {
        const ins = await client.query(
          `INSERT INTO categories (name, sort_order, is_bar, default_course, printer_id, color)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [sub.name, sort++, c.is_bar || 0, c.default_course || 1, c.printer_id ?? null, c.color ?? null],
        );
        const newId = ins.rows[0].id;
        const moved = await client.query(
          `UPDATE menu_items SET category_id = $1, subcategory_id = NULL WHERE subcategory_id = $2`,
          [newId, sub.id],
        );
        await client.query(`DELETE FROM subcategories WHERE id = $1`, [sub.id]);
        console.log(`  ✓ "${sub.name}" → category #${newId} (${moved.rowCount} items moved)`);
      }
    }
    if (!KEEP_EMPTY) {
      const empties = await client.query(
        `SELECT c.id, c.name FROM categories c
         WHERE NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.category_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM subcategories s WHERE s.category_id = c.id)
           AND c.id = ANY($1::int[])`,
        [cats.map(c => c.id)],  // only ORIGINAL parents can be deleted, never the new ones
      );
      for (const e of empties.rows) {
        await client.query(`DELETE FROM categories WHERE id = $1`, [e.id]);
        emptyParents.push(e.name);
      }
    }
    const after = await client.query(`SELECT COUNT(*)::int AS n FROM menu_items`);
    if (after.rows[0].n !== totalItems) throw new Error(`item count changed ${totalItems} → ${after.rows[0].n} — rolling back`);
    const orphans = await client.query(`SELECT COUNT(*)::int AS n FROM menu_items WHERE category_id IS NULL`);
    await client.query('COMMIT');
    console.log(`DONE — items unchanged at ${totalItems}; uncategorised items: ${orphans.rows[0].n}; empty parents deleted: ${emptyParents.length ? emptyParents.join(', ') : 'none'}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
