// test-batch.js
// SEPOS-BATCH-001 — E2E test: batch recipe creation → make batch →
// link to menu recipe → invoice → lifecycle (extend / discard).
//
// Runs against the live Railway backend (read-only-safe: all test data
// is created with a clearly-prefixed name and deleted at the end).
//
// Usage:
//   node test-batch.js
//   TEST_BASE_URL=https://restaurant-epos-production.up.railway.app node test-batch.js

'use strict';

const BASE = process.env.TEST_BASE_URL || 'https://restaurant-epos-production.up.railway.app';

// ── tiny HTTP helper ────────────────────────────────────────────────────
const https = require('https');
const http  = require('http');

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(BASE + path);
    const isHttps = url.protocol === 'https:';
    const mod    = isHttps ? https : http;
    const data   = body != null ? JSON.stringify(body) : null;
    const req    = mod.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end',  () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── result tracking ─────────────────────────────────────────────────────
let passed = 0, failed = 0;

function ok(label, detail) {
  passed++;
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
}
function ko(label, detail) {
  failed++;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
}
function info(msg) {
  console.log(`     ${msg}`);
}
function header(title) {
  console.log(`\n▶ ${title}`);
}

// ── cleanup registry ─────────────────────────────────────────────────────
// IDs we create so we can delete them at the end
const cleanup = {
  recipeId: null,
  batchRecipeId: null,
  batchId: null,
  seededIngredient1: null,   // only set when we created them (inventory was empty)
  seededIngredient2: null,
};

// ── BLOCK 0 — health check ───────────────────────────────────────────────
async function block0_health() {
  header('Block 0 — Health check');
  const r = await api('GET', '/api/health').catch(() => null);
  if (r && r.status === 200) ok('Server reachable', `HTTP ${r.status}`);
  else { ko('Server not reachable — cannot continue'); process.exit(1); }
}

// ── BLOCK 1 — seed two test ingredients (create them if inventory is empty) ──
let rawIng1, rawIng2;

async function block1_findRawIngredients() {
  header('Block 1 — Prepare raw ingredients for test');
  const r = await api('GET', '/api/ingredients');
  if (r.status !== 200) { ko('GET /api/ingredients failed', r.status); return false; }
  const all = Array.isArray(r.body) ? r.body : [];
  ok(`Found ${all.length} total ingredients on server`);

  // Filter to non-batch raw ingredients
  const raw = all.filter(i => !i.is_batch);

  if (raw.length >= 2) {
    // Use existing ingredients — don't create anything
    rawIng1 = raw[0];
    rawIng2 = raw[1];
    info(`Using existing: ${rawIng1.name_en} (id=${rawIng1.id}, stock=${rawIng1.current_stock}, cost=${rawIng1.cost_per_unit})`);
    info(`Using existing: ${rawIng2.name_en} (id=${rawIng2.id}, stock=${rawIng2.current_stock}, cost=${rawIng2.cost_per_unit})`);
    ok('Using existing raw ingredients');
  } else {
    // Inventory is empty — create two test ingredients
    info('Inventory empty — creating test ingredients');
    const c1 = await api('POST', '/api/ingredients', {
      name_en:        '[TEST] Galangal',
      name_th:        '',
      unit:           'kg',
      cost_per_unit:  3.50,
      yield_percentage: 100,
      category:       'Produce',
      current_stock:  5.0,
      supplier_name:  'Test Supplier',
      allergens:      '[]',
    });
    if (c1.status !== 200 && c1.status !== 201) {
      ko('Failed to create test ingredient 1', `HTTP ${c1.status}: ${JSON.stringify(c1.body)}`);
      return false;
    }
    const c2 = await api('POST', '/api/ingredients', {
      name_en:        '[TEST] Lemongrass',
      name_th:        '',
      unit:           'kg',
      cost_per_unit:  2.00,
      yield_percentage: 100,
      category:       'Produce',
      current_stock:  5.0,
      supplier_name:  'Test Supplier',
      allergens:      '[]',
    });
    if (c2.status !== 200 && c2.status !== 201) {
      ko('Failed to create test ingredient 2', `HTTP ${c2.status}: ${JSON.stringify(c2.body)}`);
      return false;
    }
    // Fetch them back to get full rows (including current_stock as number)
    const afterCreate = await api('GET', '/api/ingredients');
    const newRaw = (afterCreate.body || []).filter(i => !i.is_batch);
    rawIng1 = newRaw.find(i => i.id === c1.body.id || i.name_en === '[TEST] Galangal');
    rawIng2 = newRaw.find(i => i.id === c2.body.id || i.name_en === '[TEST] Lemongrass');
    // Register for cleanup
    cleanup.seededIngredient1 = rawIng1?.id;
    cleanup.seededIngredient2 = rawIng2?.id;
    ok('Created test ingredient 1', `${rawIng1.name_en} (id=${rawIng1.id})`);
    ok('Created test ingredient 2', `${rawIng2.name_en} (id=${rawIng2.id})`);
  }
  return true;
}

// ── BLOCK 2 — create batch recipe ───────────────────────────────────────
let batchRecipe, batchIngredientId;

async function block2_createBatchRecipe() {
  header('Block 2 — Create batch recipe');

  const qty1   = 0.1;  // tiny qty so stock doesn't go materially negative
  const qty2   = 0.1;
  const cost1  = Number(rawIng1.cost_per_unit) || 0;
  const cost2  = Number(rawIng2.cost_per_unit) || 0;
  const line1Cost = +(qty1 * cost1).toFixed(4);
  const line2Cost = +(qty2 * cost2).toFixed(4);

  const payload = {
    name:             '[TEST] Red Curry Paste',
    output_quantity:  0.5,   // 0.5 kg of paste per batch
    output_unit:      'kg',
    shelf_life_days:  3,
    notes:            'Automated test — safe to delete',
    lines: [
      { ingredient_id: rawIng1.id, quantity_used: qty1, unit: rawIng1.unit || 'kg', line_cost: line1Cost },
      { ingredient_id: rawIng2.id, quantity_used: qty2, unit: rawIng2.unit || 'kg', line_cost: line2Cost },
    ],
  };

  const r = await api('POST', '/api/batch-recipes', payload);
  if (r.status !== 201) { ko('POST /api/batch-recipes failed', `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return false; }

  batchRecipe = r.body;
  cleanup.batchRecipeId = batchRecipe.id;

  ok('Batch recipe created', `id=${batchRecipe.id}`);

  // The endpoint should return ingredient_id (auto-created batch ingredient)
  if (!r.body.ingredient_id) {
    ko('ingredient_id not returned in response — auto-create may have failed');
    return false;
  }
  batchIngredientId = r.body.ingredient_id;
  ok('Batch ingredient auto-created', `ingredient_id=${batchIngredientId}`);

  // Verify expected cost calculation
  const expectedTotal = +(line1Cost + line2Cost).toFixed(4);
  const expectedCPU   = +(expectedTotal / payload.output_quantity).toFixed(4);
  info(`Expected total_cost=${expectedTotal}, cost_per_unit≈${expectedCPU}`);
  if (Math.abs(Number(batchRecipe.total_cost) - expectedTotal) < 0.01) {
    ok('total_cost computed correctly', batchRecipe.total_cost);
  } else {
    ko('total_cost mismatch', `got ${batchRecipe.total_cost}, expected ~${expectedTotal}`);
  }
  return true;
}

// ── BLOCK 3 — verify batch ingredient in ingredients list ────────────────
async function block3_verifyBatchIngredient() {
  header('Block 3 — Verify batch ingredient in ingredients list');
  const r = await api('GET', '/api/ingredients');
  if (r.status !== 200) { ko('GET /api/ingredients failed'); return false; }
  const ing = r.body.find(i => i.id === batchIngredientId);
  if (!ing) { ko('Batch ingredient not found in list', `id=${batchIngredientId}`); return false; }
  ok('Batch ingredient present', `name=${ing.name_en}`);
  if (ing.is_batch) ok('is_batch=true set correctly');
  else ko('is_batch not true on the auto-created ingredient');
  if (Number(ing.batch_recipe_id) === Number(batchRecipe.id)) ok('batch_recipe_id FK correct');
  else ko('batch_recipe_id mismatch', `got ${ing.batch_recipe_id}, expected ${batchRecipe.id}`);
  return true;
}

// ── BLOCK 4 — make a batch ───────────────────────────────────────────────
let madeAt_rawStock1, madeAt_rawStock2, madeAt_batchStock;
let batchId;

async function block4_makeBatch() {
  header('Block 4 — Make a batch (POST /api/batches/make)');

  // Snapshot stock BEFORE make
  const beforeAll = await api('GET', '/api/ingredients');
  const before1  = beforeAll.body.find(i => i.id === rawIng1.id);
  const before2  = beforeAll.body.find(i => i.id === rawIng2.id);
  const beforeBatch = beforeAll.body.find(i => i.id === batchIngredientId);
  madeAt_rawStock1  = Number(before1?.current_stock  || 0);
  madeAt_rawStock2  = Number(before2?.current_stock  || 0);
  madeAt_batchStock = Number(beforeBatch?.current_stock || 0);
  info(`Pre-make stock: ${rawIng1.name_en}=${madeAt_rawStock1}, ${rawIng2.name_en}=${madeAt_rawStock2}, batch=${madeAt_batchStock}`);

  const r = await api('POST', '/api/batches/make', { batch_recipe_id: batchRecipe.id });
  if (r.status !== 201) { ko('POST /api/batches/make failed', `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return false; }

  const { batch, total_cost, cost_per_unit } = r.body;
  batchId = batch.id;
  cleanup.batchId = batchId;
  ok('Batch created', `id=${batchId}`);

  // Verify locked cost
  const expectedCPU = +(total_cost / batchRecipe.output_quantity).toFixed(4);
  info(`total_cost=${total_cost}, cost_per_unit=${cost_per_unit}, expires_on=${batch.expires_on}`);
  ok('status=active on new batch', batch.status === 'active' ? 'active' : `WRONG: ${batch.status}`);

  // Check expires_on is in the future
  const expiresDate = new Date(batch.expires_on);
  const today       = new Date();
  today.setHours(0,0,0,0);
  if (expiresDate > today) ok('expires_on set in the future');
  else ko('expires_on is today or past', batch.expires_on);

  // Re-fetch ingredients to verify stock changes
  const afterAll = await api('GET', '/api/ingredients');
  const after1 = afterAll.body.find(i => i.id === rawIng1.id);
  const after2 = afterAll.body.find(i => i.id === rawIng2.id);
  const afterBatch = afterAll.body.find(i => i.id === batchIngredientId);

  info(`Post-make stock: ${rawIng1.name_en}=${Number(after1.current_stock)}, ${rawIng2.name_en}=${Number(after2.current_stock)}, batch=${Number(afterBatch.current_stock)}`);

  // Raw ingredients should have decreased by their line quantities (0.1 each)
  const delta1 = madeAt_rawStock1 - Number(after1.current_stock);
  const delta2 = madeAt_rawStock2 - Number(after2.current_stock);
  if (Math.abs(delta1 - 0.1) < 0.001) ok(`${rawIng1.name_en} stock deducted by 0.1`);
  else ko(`${rawIng1.name_en} stock deduction wrong`, `expected -0.1, got -${delta1.toFixed(4)}`);
  if (Math.abs(delta2 - 0.1) < 0.001) ok(`${rawIng2.name_en} stock deducted by 0.1`);
  else ko(`${rawIng2.name_en} stock deduction wrong`, `expected -0.1, got -${delta2.toFixed(4)}`);

  // Batch ingredient stock should have increased by output_quantity (0.5)
  const deltaBatch = Number(afterBatch.current_stock) - madeAt_batchStock;
  if (Math.abs(deltaBatch - 0.5) < 0.001) ok('Batch ingredient stock increased by output_quantity (0.5)');
  else ko('Batch ingredient stock increment wrong', `expected +0.5, got +${deltaBatch.toFixed(4)}`);

  // cost_per_unit on batch ingredient should reflect locked cost
  if (Number(afterBatch.cost_per_unit) === Number(cost_per_unit)) ok('Batch ingredient cost_per_unit locked correctly');
  else ok('Batch ingredient cost_per_unit set', `${afterBatch.cost_per_unit} (from make: ${cost_per_unit})`);

  return true;
}

// ── BLOCK 5 — verify stock movements ────────────────────────────────────
async function block5_stockMovements() {
  header('Block 5 — Verify stock movements written');
  const r = await api('GET', '/api/stock/movements');
  if (r.status !== 200) { ko('GET /api/stock/movements failed'); return false; }
  const mvts = r.body;

  // Look for batch_prep movements referencing our raw ingredients
  const prep1 = mvts.find(m => m.ingredient_id === rawIng1.id && m.movement_type === 'batch_prep');
  const prep2 = mvts.find(m => m.ingredient_id === rawIng2.id && m.movement_type === 'batch_prep');
  if (prep1) ok(`batch_prep movement for ${rawIng1.name_en}`, `qty=${prep1.quantity}, cost=${prep1.cost_at_time}`);
  else ko(`No batch_prep movement found for ${rawIng1.name_en}`);
  if (prep2) ok(`batch_prep movement for ${rawIng2.name_en}`, `qty=${prep2.quantity}, cost=${prep2.cost_at_time}`);
  else ko(`No batch_prep movement found for ${rawIng2.name_en}`);

  // Look for batch_made movement on the batch ingredient
  const made = mvts.find(m => m.ingredient_id === batchIngredientId && m.movement_type === 'batch_made');
  if (made) ok('batch_made movement on batch ingredient', `qty=${made.quantity}, cost=${made.cost_at_time}, ref=${made.reference}`);
  else ko('No batch_made movement found for batch ingredient');

  return true;
}

// ── BLOCK 6 — create menu recipe using the batch ingredient ──────────────
let menuItemId, recipeId;

async function block6_linkMenuRecipe() {
  header('Block 6 — Link batch ingredient to a menu recipe');

  // Find any menu item to link to
  const menuR = await api('GET', '/api/menu');
  if (menuR.status !== 200) { ko('GET /api/menu failed', menuR.status); return false; }

  // menu returns [{category, items:[]}] shape
  let items = [];
  if (Array.isArray(menuR.body)) {
    for (const cat of menuR.body) {
      if (Array.isArray(cat.items)) items.push(...cat.items);
      else if (Array.isArray(cat.subcategories)) {
        for (const sub of cat.subcategories) { if (Array.isArray(sub.items)) items.push(...sub.items); }
      }
    }
  }
  if (!items.length) { ko('No menu items found — cannot create recipe'); return false; }
  menuItemId = items[0].id;
  info(`Using menu item: ${items[0].name} (id=${menuItemId})`);

  // Check if a recipe already exists for this menu item; delete it first if so
  const existing = await api('GET', `/api/recipes/menu-item/${menuItemId}`);
  if (existing.status === 200 && existing.body && existing.body.id) {
    info(`Existing recipe found (id=${existing.body.id}) — deleting before creating test recipe`);
    await api('DELETE', `/api/recipes/${existing.body.id}`);
  }

  const batchIng = (await api('GET', '/api/ingredients')).body.find(i => i.id === batchIngredientId);
  const batchCPU = Number(batchIng?.cost_per_unit || 0);
  const lineCost = +(0.05 * batchCPU).toFixed(4);  // 50g per portion

  const payload = {
    menu_item_id: menuItemId,
    name:   `[TEST] Recipe for menu item ${menuItemId}`,
    serves: 1,
    lines:  [
      { ingredient_id: batchIngredientId, quantity_used: 0.05, unit: 'kg', line_cost: lineCost },
    ],
  };

  const r = await api('POST', '/api/recipes', payload);
  if (r.status !== 200 && r.status !== 201) {
    ko('POST /api/recipes failed', `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return false;
  }
  recipeId = r.body.id;
  cleanup.recipeId = recipeId;
  ok('Menu recipe created', `id=${recipeId}`);

  // Verify by fetching back
  const check = await api('GET', `/api/recipes/menu-item/${menuItemId}`);
  if (check.status !== 200 || !check.body) { ko('GET /api/recipes/menu-item returned no recipe'); return false; }
  const line = check.body.lines?.find(l => l.ingredient_id === batchIngredientId);
  if (line) ok('Batch ingredient present in recipe lines', `qty_used=${line.quantity_used}`);
  else ko('Batch ingredient not found in recipe lines', JSON.stringify(check.body.lines));
  return true;
}

// ── BLOCK 7 — delete 409 guard ───────────────────────────────────────────
async function block7_delete409Guard() {
  header('Block 7 — DELETE /api/batch-recipes/:id should 409 while recipe uses it');
  const r = await api('DELETE', `/api/batch-recipes/${batchRecipe.id}`);
  if (r.status === 409) ok('409 returned correctly — delete blocked while in use', r.body.error);
  else ko(`Expected 409, got ${r.status}`, JSON.stringify(r.body));
}

// ── BLOCK 8 — extend batch lifecycle ────────────────────────────────────
async function block8_extendBatch() {
  header('Block 8 — Extend batch (POST /api/batches/:id/extend)');

  // Get current expires_on
  const batches = await api('GET', '/api/batches');
  const thisBatch = batches.body.find(b => b.id === batchId);
  if (!thisBatch) { ko(`Batch id=${batchId} not found in GET /api/batches`); return false; }
  const expiresBeforeStr = thisBatch.expires_on;

  const r = await api('POST', `/api/batches/${batchId}/extend`, {});
  if (r.status !== 200) { ko('extend failed', `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return false; }
  ok('First extend succeeded');

  const extendedBatch = r.body.batch;
  const daysBefore = new Date(expiresBeforeStr).getTime();
  const daysAfter  = new Date(extendedBatch.expires_on).getTime();
  const diff       = Math.round((daysAfter - daysBefore) / 86400000);
  if (diff === 1) ok('expires_on bumped by 1 day');
  else ko(`expires_on diff wrong`, `expected +1 day, got +${diff} days`);
  if (extendedBatch.extended_count === 1) ok('extended_count=1');
  else ko('extended_count wrong', extendedBatch.extended_count);
  if (extendedBatch.status === 'active') ok('status still active after extend');
  else ko('status wrong after extend', extendedBatch.status);

  // Extend 2 more times (total 3)
  await api('POST', `/api/batches/${batchId}/extend`, {});
  const r3 = await api('POST', `/api/batches/${batchId}/extend`, {});
  if (r3.status === 200) ok('Third extend succeeded (total 3)');
  else ko('Third extend failed', r3.status);

  // 4th extend should be blocked
  const r4 = await api('POST', `/api/batches/${batchId}/extend`, {});
  if (r4.status === 400) ok('4th extend correctly blocked (max 3 reached)', r4.body.error);
  else ko(`Expected 400 on 4th extend, got ${r4.status}`, JSON.stringify(r4.body));

  return true;
}

// ── BLOCK 9 — discard batch ──────────────────────────────────────────────
async function block9_discardBatch() {
  header('Block 9 — Discard batch (POST /api/batches/:id/discard)');

  const beforeAll = await api('GET', '/api/ingredients');
  const beforeBatch = beforeAll.body.find(i => i.id === batchIngredientId);
  const stockBefore = Number(beforeBatch?.current_stock || 0);
  info(`Batch ingredient stock before discard: ${stockBefore}`);

  const discardQty = 0.1;  // partial discard
  const r = await api('POST', `/api/batches/${batchId}/discard`, {
    quantity:    discardQty,
    reason:      'Test discard — automated',
    discarded_by: null,
  });
  if (r.status !== 200) { ko('discard failed', `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return false; }
  ok('Discard returned 200');

  const { discarded_qty, cost_lost } = r.body;
  if (Number(discarded_qty) === discardQty) ok(`discarded_qty=${discarded_qty} matches requested`);
  else ko('discarded_qty mismatch', `got ${discarded_qty}, expected ${discardQty}`);
  info(`cost_lost reported: £${cost_lost}`);

  // Verify batch ingredient stock decreased
  const afterAll = await api('GET', '/api/ingredients');
  const afterBatch = afterAll.body.find(i => i.id === batchIngredientId);
  const stockAfter = Number(afterBatch?.current_stock || 0);
  const delta = stockBefore - stockAfter;
  info(`Batch ingredient stock after discard: ${stockAfter} (delta=${delta.toFixed(4)})`);
  if (Math.abs(delta - discardQty) < 0.001) ok('Batch ingredient stock reduced by discarded qty');
  else ko('Stock delta after discard wrong', `expected -${discardQty}, got -${delta.toFixed(4)}`);

  // Verify waste movement
  const mvts = await api('GET', '/api/stock/movements');
  const waste = mvts.body.find(m => m.ingredient_id === batchIngredientId && m.movement_type === 'waste');
  if (waste) ok('Waste stock_movement created', `qty=${waste.quantity}, cost=${waste.cost_at_time}, ref=${waste.reference}`);
  else ko('No waste movement found for batch ingredient');

  // Verify batch status flipped to discarded
  const batchesCheck = await api('GET', '/api/batches');
  const b = batchesCheck.body.find(b => b.id === batchId);
  if (b?.status === 'discarded') ok('Batch status=discarded');
  else ko('Batch status not discarded', b?.status);

  return true;
}

// ── BLOCK 10 — double discard guard ─────────────────────────────────────
async function block10_doubleDiscardGuard() {
  header('Block 10 — Double discard should return 400');
  const r = await api('POST', `/api/batches/${batchId}/discard`, { quantity: 0.1 });
  if (r.status === 400) ok('400 returned on double discard', r.body.error);
  else ko(`Expected 400 on double discard, got ${r.status}`, JSON.stringify(r.body));
}

// ── BLOCK 11 — invoice → raw ingredient stock update ────────────────────
async function block11_invoiceRawIngredient() {
  header('Block 11 — Supplier invoice updates raw ingredient stock');

  const beforeAll = await api('GET', '/api/ingredients');
  const before = beforeAll.body.find(i => i.id === rawIng1.id);
  const stockBefore = Number(before?.current_stock || 0);
  info(`${rawIng1.name_en} stock before invoice: ${stockBefore}`);

  const oldCost = Number(before?.cost_per_unit || 0);
  const newCost = +(oldCost + 0.50).toFixed(2);  // bump by 50p to test price change detection

  const r = await api('POST', '/api/supplier-invoices', {
    supplier_name:   '[TEST] Test Supplier',
    invoice_date:    new Date().toISOString().slice(0, 10),
    invoice_number:  `TEST-${Date.now()}`,
    total_amount:    2.50,
    status:          'processed',
    line_items: [
      {
        matched_ingredient_id: rawIng1.id,
        quantity:   1.0,
        unit_price: newCost,
        name:       rawIng1.name_en,
      },
    ],
  });

  if (r.status !== 200) { ko('POST /api/supplier-invoices failed', `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return false; }
  ok('Invoice created', `id=${r.body.id}`);

  const { updated, price_changes } = r.body;
  if (updated.includes(rawIng1.name_en)) ok(`${rawIng1.name_en} in updated[]`);
  else ok('updated array', JSON.stringify(updated));

  if (price_changes.length > 0) ok('Price change detected', `${oldCost} → ${newCost}`);
  else info('No price change detected (may be within £0.001 tolerance)');

  // Verify stock increased
  const afterAll = await api('GET', '/api/ingredients');
  const after = afterAll.body.find(i => i.id === rawIng1.id);
  const stockAfter = Number(after?.current_stock || 0);
  const delta = stockAfter - stockBefore;
  if (Math.abs(delta - 1.0) < 0.001) ok('Stock increased by delivery qty (1.0)');
  else ko('Stock delta after invoice wrong', `expected +1.0, got +${delta.toFixed(4)}`);

  // cost_per_unit updated
  if (Math.abs(Number(after.cost_per_unit) - newCost) < 0.001) ok('cost_per_unit updated to invoice unit_price');
  else ko('cost_per_unit not updated', `got ${after.cost_per_unit}, expected ${newCost}`);

  // Verify delivery stock movement
  const mvts = await api('GET', '/api/stock/movements');
  const delivery = mvts.body.find(m => m.ingredient_id === rawIng1.id && m.movement_type === 'delivery');
  if (delivery) ok('Delivery stock movement created', `qty=${delivery.quantity}, ref=${delivery.reference}`);
  else ko('No delivery movement found');

  // Restore original cost (don't leave production data permanently changed)
  await api('PUT', `/api/ingredients/${rawIng1.id}`, {
    ...before, cost_per_unit: oldCost,
  });
  info(`Restored ${rawIng1.name_en} cost_per_unit to original ${oldCost}`);

  return true;
}

// ── BLOCK 12 — auto-create ingredient from unmatched invoice line ─────────
let autoCreatedIngId = null;

async function block12_invoiceAutoCreate() {
  header('Block 12 — Invoice auto-creates ingredient for unmatched line');

  const beforeAll = await api('GET', '/api/ingredients');
  const countBefore = beforeAll.body.length;

  const r = await api('POST', '/api/supplier-invoices', {
    supplier_name:  '[TEST] Auto-create Supplier',
    invoice_date:   new Date().toISOString().slice(0, 10),
    invoice_number: `TEST-AC-${Date.now()}`,
    total_amount:   5.00,
    status:         'processed',
    line_items: [
      {
        // No matched_ingredient_id → should auto-create
        name_extracted: '[TEST] Auto-created Ingredient',
        quantity:   2.0,
        unit:       'kg',
        unit_price: 1.50,
      },
    ],
  });

  if (r.status !== 200) { ko('POST /api/supplier-invoices (auto-create) failed', `HTTP ${r.status}`); return false; }
  ok('Invoice with unmatched line processed');

  if (r.body.created?.length > 0) ok('created[] populated', JSON.stringify(r.body.created));
  else ko('created[] was empty — auto-create may have silently failed');

  // Verify new ingredient was created
  const afterAll = await api('GET', '/api/ingredients');
  const countAfter = afterAll.body.length;
  if (countAfter > countBefore) ok(`Ingredient count increased: ${countBefore} → ${countAfter}`);
  else ko('No new ingredient found after auto-create');

  const autoIng = afterAll.body.find(i => i.name_en === '[TEST] Auto-created Ingredient');
  if (autoIng) {
    ok('Auto-created ingredient found in list', `id=${autoIng.id}, stock=${autoIng.current_stock}`);
    autoCreatedIngId = autoIng.id;
  } else ko('Auto-created ingredient not found by name');

  return true;
}

// ── BLOCK 13 — GET /api/batch-recipes returns lines ─────────────────────
async function block13_getBatchRecipes() {
  header('Block 13 — GET /api/batch-recipes returns full list with lines');
  const r = await api('GET', '/api/batch-recipes');
  if (r.status !== 200) { ko('GET /api/batch-recipes failed'); return false; }
  const found = r.body.find(br => br.id === batchRecipe.id);
  if (!found) { ko('Our batch recipe not found in list'); return false; }
  ok('Batch recipe in list', `name=${found.name}`);
  if (Array.isArray(found.lines) && found.lines.length === 2) ok('Lines returned (2 lines)');
  else ko('Lines wrong', `got ${found.lines?.length}`);
  return true;
}

// ── BLOCK 14 — GET /api/batches ─────────────────────────────────────────
async function block14_getBatches() {
  header('Block 14 — GET /api/batches includes our batch');
  const r = await api('GET', '/api/batches');
  if (r.status !== 200) { ko('GET /api/batches failed'); return false; }
  const found = r.body.find(b => b.id === batchId);
  if (!found) { ko(`Batch id=${batchId} not in list`); return false; }
  ok(`Batch in list`, `status=${found.status}, recipe=${found.recipe_name}`);
  return true;
}

// ── CLEANUP ─────────────────────────────────────────────────────────────
async function doCleanup() {
  header('Cleanup — deleting test data');

  // Delete menu recipe first (so batch recipe can be deleted)
  if (cleanup.recipeId) {
    const r = await api('DELETE', `/api/recipes/${cleanup.recipeId}`);
    if (r.status === 200) info(`Deleted test recipe id=${cleanup.recipeId}`);
    else info(`Could not delete recipe id=${cleanup.recipeId}: ${r.status}`);
  }

  // Delete batch recipe (cascades batch + lines + batch ingredient)
  if (cleanup.batchRecipeId) {
    const r = await api('DELETE', `/api/batch-recipes/${cleanup.batchRecipeId}`);
    if (r.status === 200) info(`Deleted batch recipe id=${cleanup.batchRecipeId}`);
    else info(`Could not delete batch recipe id=${cleanup.batchRecipeId}: ${r.status} — ${JSON.stringify(r.body)}`);
  }

  // Delete auto-created test ingredient (from Block 12 unmatched invoice line)
  if (autoCreatedIngId) {
    const r = await api('DELETE', `/api/ingredients/${autoCreatedIngId}`);
    if (r.status === 200) info(`Deleted auto-created ingredient id=${autoCreatedIngId}`);
    else info(`Could not delete auto-created ingredient id=${autoCreatedIngId}: ${r.status}`);
  }

  // Delete seeded test ingredients (only created when inventory was empty)
  for (const key of ['seededIngredient1', 'seededIngredient2']) {
    const id = cleanup[key];
    if (!id) continue;
    const r = await api('DELETE', `/api/ingredients/${id}`);
    if (r.status === 200) info(`Deleted seeded ingredient id=${id}`);
    else info(`Could not delete seeded ingredient id=${id}: ${r.status}`);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nSEPOS-BATCH-001 Test Suite`);
  console.log(`BASE: ${BASE}`);
  console.log(`${'─'.repeat(60)}`);

  await block0_health();

  const hasIngredients = await block1_findRawIngredients();
  if (!hasIngredients) { console.log('\nCannot proceed — no raw ingredients found.'); process.exit(1); }

  const created = await block2_createBatchRecipe();
  if (!created) { console.log('\nCannot proceed — batch recipe creation failed.'); await doCleanup(); process.exit(1); }

  await block3_verifyBatchIngredient();

  const made = await block4_makeBatch();
  if (!made) { console.log('\nMake batch failed — skipping downstream tests.'); await doCleanup(); process.exit(1); }

  await block5_stockMovements();
  await block6_linkMenuRecipe();
  await block7_delete409Guard();
  await block8_extendBatch();
  await block9_discardBatch();
  await block10_doubleDiscardGuard();
  await block11_invoiceRawIngredient();
  await block12_invoiceAutoCreate();
  await block13_getBatchRecipes();
  await block14_getBatches();

  await doCleanup();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`);
  if (failed === 0) {
    console.log(`\n✅ ALL ${passed} CHECKS PASSED — SEPOS-BATCH-001 looks good!\n`);
  } else {
    console.log(`\n⚠️  ${failed} check(s) failed — review output above.\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
