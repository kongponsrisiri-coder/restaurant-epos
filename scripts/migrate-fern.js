#!/usr/bin/env node
// FERN-001 — one-shot data migration: Baan Siam (shared demo cloud) → Fern's own DB.
// Copies configuration/menu data, SKIPS demo transactions (orders, payments,
// customers, reservations, sessions, inventory movements).
//
// Usage:
//   SRC_DB=postgresql://…(baan-siam) DST_DB=postgresql://…(fern) node scripts/migrate-fern.js
//
// Safety:
//   - refuses to run if the destination already has menu data (no accidental double-run)
//   - copies inside a single transaction on the destination
//   - resets sequences after copy so new inserts don't collide
//   - post-copy fixes: timezone Europe/London, currency GBP, restaurant_id → 'fern'

const { Client } = require('pg');
const fs = require('fs');

// Connection strings come from files (chmod 600) so they never appear on the
// command line or in shell history: pass the two file paths as argv.
if (process.argv[2] && process.argv[3]) {
  process.env.SRC_DB = fs.readFileSync(process.argv[2], 'utf8').trim();
  process.env.DST_DB = fs.readFileSync(process.argv[3], 'utf8').trim();
}

// Config / menu tables to copy, in FK-safe order (verified against
// src/db/database.js CREATE TABLE list). Transactional/demo tables
// (orders, payments, reservations, customers/campaigns, vouchers,
// till_sessions, z_reports, inventory) are deliberately NOT copied.
const TABLES = [
  'restaurants',
  'settings',
  'restaurant_settings',
  'table_walls',
  'tables',
  'table_combinations',
  'dining_duration_tiers',
  'printers',
  'categories',
  'subcategories',
  'menu_items',
  'modifier_groups',
  'modifiers',
  'menu_item_modifier_groups',
  'staff',
  'discount_reasons',
  'kitchen_message_templates',
];

(async () => {
  const src = new Client({ connectionString: process.env.SRC_DB, ssl: { rejectUnauthorized: false } });
  const dst = new Client({ connectionString: process.env.DST_DB, ssl: { rejectUnauthorized: false } });
  if (!process.env.SRC_DB || !process.env.DST_DB) { console.error('SRC_DB and DST_DB required'); process.exit(1); }
  await src.connect(); await dst.connect();

  // table_schema='public' is REQUIRED: our table named "tables" otherwise also
  // matches information_schema's own views, polluting the column list with
  // system columns (table_catalog, …) that don't exist on the real table.
  const tableExists = async (c, t) =>
    (await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).rowCount > 0;
  const colsOf = async (c, t) =>
    (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t])).rows.map(r => r.column_name);

  // Guard: destination must be empty of menu data.
  if (await tableExists(dst, 'menu_items')) {
    const n = (await dst.query('SELECT COUNT(*)::int AS n FROM menu_items')).rows[0].n;
    if (n > 0) { console.error(`ABORT: destination already has ${n} menu_items — refusing to double-run`); process.exit(2); }
  } else {
    console.error('ABORT: destination has no menu_items table — has the app deployed & migrated yet?'); process.exit(3);
  }

  await dst.query('BEGIN');
  try {
    const report = [];
    for (const t of TABLES) {
      process.stderr.write(`… ${t}\n`);
      if (!(await tableExists(src, t))) { report.push(`${t}: (absent in source — skipped)`); continue; }
      if (!(await tableExists(dst, t))) { report.push(`${t}: (absent in dest — skipped)`); continue; }
      const srcCols = await colsOf(src, t);
      const dstCols = await colsOf(dst, t);
      const cols = srcCols.filter(c => dstCols.includes(c));
      const rows = (await src.query(`SELECT ${cols.map(c => `"${c}"`).join(',')} FROM "${t}"`)).rows;
      // settings: copy row-by-row as upsert (dest may have seeded defaults)
      if (t === 'settings') {
        for (const r of rows) {
          await dst.query(
            `INSERT INTO settings (key, value) VALUES ($1,$2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [r.key, r.value]);
        }
        report.push(`settings: ${rows.length} upserted`);
        continue;
      }
      await dst.query(`DELETE FROM "${t}"`);
      for (const r of rows) {
        const vals = cols.map(c => r[c]);
        await dst.query(
          `INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(',')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
      report.push(`${t}: ${rows.length} rows`);
      // reset sequence if the table has a serial id
      if (cols.includes('id')) {
        await dst.query(
          `SELECT setval(pg_get_serial_sequence('"${t}"','id'),
                         COALESCE((SELECT MAX(id) FROM "${t}"), 1))`).catch(() => {});
      }
    }

    // Post-copy hygiene fixes
    await dst.query(`INSERT INTO settings (key,value) VALUES ('timezone','Europe/London')
                     ON CONFLICT (key) DO UPDATE SET value='Europe/London'`);
    await dst.query(`INSERT INTO settings (key,value) VALUES ('currency','GBP')
                     ON CONFLICT (key) DO UPDATE SET value='GBP'`);
    // retag tenant id wherever the column exists. Tables where restaurant_id is
    // UNIQUE/PK (restaurants, restaurant_settings) carried one row per tenant in
    // the shared demo DB — collapse those to a single row first (prefer the
    // active 'baan-siam' row over the 'siamepos' default), then retag to fern.
    // true when ANY unique/pk constraint on the table involves restaurant_id —
    // merging two tenants' rows under one rid would collide there.
    const ridInUnique = async (t) => (await dst.query(`
      SELECT 1 FROM pg_index i
      JOIN pg_class rel ON rel.oid = i.indrelid
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(i.indkey)
      WHERE rel.relname = $1 AND i.indisunique AND att.attname = 'restaurant_id'
    `, [t])).rowCount > 0;
    for (const t of TABLES.filter(t => t !== 'settings')) {
      if (!(await tableExists(dst, t))) continue;
      const cols = await colsOf(dst, t);
      if (!cols.includes('restaurant_id')) continue;
      if (await ridInUnique(t)) {
        // keep the active tenant's row-set only (baan-siam if present, else whatever's there)
        const hasBaan = (await dst.query(`SELECT 1 FROM "${t}" WHERE restaurant_id='baan-siam' LIMIT 1`)).rowCount > 0;
        if (hasBaan) await dst.query(`DELETE FROM "${t}" WHERE restaurant_id <> 'baan-siam'`);
        else await dst.query(`DELETE FROM "${t}" WHERE restaurant_id <> (
                SELECT restaurant_id FROM "${t}" LIMIT 1)`);
      }
      await dst.query(`UPDATE "${t}" SET restaurant_id='fern'`);
    }
    // identity row carries the customer-facing name
    await dst.query(`UPDATE restaurants SET name='Fern Modern Sushi'`).catch(() => {});

    await dst.query('COMMIT');
    console.log('MIGRATION COMPLETE');
    report.forEach(l => console.log('  ' + l));
  } catch (e) {
    await dst.query('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exit(4);
  } finally {
    await src.end(); await dst.end();
  }
})();
